/* jshint esversion: 8 */

import { get as idbGet, set as idbSet, del as idbDel, entries as idbEntries, createStore as createIdbStore } from 'idb-keyval';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import * as nip04 from 'nostr-tools/nip04';
import { Relay } from 'nostr-tools/relay';
import * as nip19 from 'nostr-tools/nip19';
import createDebug from 'debug';

// Default relays that are known to be reliable
const DEFAULT_RELAYS = [
  'wss://relay.damus.io',
  'wss://relay.nostr.band',
  'wss://nos.lol'
];

// Default debounce time in milliseconds
// Ensures created_at timestamp is never duplicated
const DEFAULT_DEBOUNCE = 1010;

/**
 * Creates a key-value store that syncs with Nostr
 * @param {Object} options Configuration options
 * @param {string} options.namespace Namespace for the store
 * @param {string} [options.authNsec] Secret key for publishing (will be generated if not provided)
 * @param {string} [options.kvNsec] Secret key for encryption (will be generated if not provided)
 * @param {string[]} [options.relays] Array of relay URLs (defaults to predefined list)
 * @param {number} [options.debounce] Debounce time in ms for rapid updates (default: 1010)
 * @param {string} [options.dbName] Custom IndexedDB database name (useful for testing)
 * @param {boolean} [options.debug] Enable debug logging (default: false)
 * @returns {Object} Store interface with get, set, del methods
 */
function createStore({
  namespace,
  authNsec,
  kvNsec,
  relays = DEFAULT_RELAYS,
  debounce = DEFAULT_DEBOUNCE,
  dbName = null,
  debug = false
}) {
  if (!namespace) {
    throw new Error('Namespace is required');
  }

  // Generate keys if not provided
  const authSecretKey = authNsec ?
    (typeof authNsec === 'string' && authNsec.startsWith('nsec') ?
      nip19.decode(authNsec).data :
      authNsec) :
    generateSecretKey();

  const kvSecretKey = kvNsec ?
    (typeof kvNsec === 'string' && kvNsec.startsWith('nsec') ?
      nip19.decode(kvNsec).data :
      kvNsec) :
    generateSecretKey();

  const authPubkey = getPublicKey(authSecretKey);
  const kvPubkey = getPublicKey(kvSecretKey);

  // Create debug loggers with namespace
  const shortAuthKey = authPubkey.substring(0, 8);
  const log = createDebug(`nostr-kv:${namespace}:${shortAuthKey}`);
  const logError = createDebug(`nostr-kv:${namespace}:${shortAuthKey}:error`);
  
  // Enable debug logging if requested
  if (debug) {
    createDebug.enable(`nostr-kv:${namespace}:${shortAuthKey}*`);
  }

  // Create a custom store for this namespace
  const dbNameToUse = dbName || `nostr-kv-${namespace}`;
  const customStore = createIdbStore(dbNameToUse, 'keyval');
  const localGet = (key) => idbGet(key, customStore);
  const localSet = (key, value) => idbSet(key, value, customStore);
  const localDel = (key) => idbDel(key, customStore);

  // Track connected relays
  const connectedRelays = [];
  let relayConnectPromise = null;

  // Debounce mechanism for sync
  let debounceTimer = null;
  let syncPromise = null;
  let syncResolve = null;

  // Change listeners and sync event listeners
  const changeListeners = [];
  const syncEventListeners = [];

  // Special meta keys (stored in a special meta key that won't be synced)
  const LAST_SYNC_KEY = '_nkvmeta_lastSync';
  let lastSyncTime = 0;

  /**
   * Connect to relays if not already connected
   */
  async function ensureRelayConnections() {
    if (relayConnectPromise) return relayConnectPromise;

    relayConnectPromise = Promise.all(
      relays.map(async (url) => {
        try {
          const relay = await Relay.connect(url);
          connectedRelays.push(relay);
          return relay;
        } catch (error) {
          logError('Failed to connect to relay %s: %O', url, error);
          return null;
        }
      })
    ).then(results => results.filter(Boolean));

    return relayConnectPromise;
  }

  /**
   * Encrypt data for storage on Nostr
   */
  async function encryptData(data) {
    return await nip04.encrypt(kvSecretKey, kvPubkey, JSON.stringify(data));
  }

  /**
   * Decrypt data from Nostr
   */
  async function decryptData(encryptedData) {
    try {
      const decrypted = await nip04.decrypt(kvSecretKey, kvPubkey, encryptedData);
      return JSON.parse(decrypted);
    } catch (error) {
      logError('Failed to decrypt  %O', error);
      return null;
    }
  }

  /**
   * Publish all data to Nostr relays
   */
  async function publishToNostr() {
    await ensureRelayConnections();

    // Get all entries from the store (except meta entries)
    const allEntries = await idbEntries(customStore);

    // Filter out meta entries and build our data structure
    const data = {};

    for (const [key, entry] of allEntries) {
      // Skip internal meta keys
      if (key.startsWith('_nkvmeta')) continue;

      if (entry && entry.meta) {
        data[key] = {
          value: entry.value,
          lastModified: entry.meta.lastModified
        };
      }
    }

    log('Publishing to Nostr - Namespace: %s, AuthPubkey: %s', namespace, authPubkey);
    log('Publishing %d entries', Object.keys(data).length);
    log('Data structure being published: %O', data);

    const encryptedContent = await encryptData(data);

    // Convert to seconds and ensure it's newer than current time
    const currentTime = Math.floor(Date.now() / 1000);

    const eventTemplate = {
      kind: 30078,
      created_at: currentTime,
      tags: [
        ["d", namespace],
        ["a", `30078:${authPubkey}:${namespace}`],
        ["p", kvPubkey]
      ],
      content: encryptedContent
    };

    const signedEvent = finalizeEvent(eventTemplate, authSecretKey);

    // Publish to all connected relays
    const publishPromises = connectedRelays.map(relay =>
      relay.publish(signedEvent).catch(err => {
        if (err.message) {
          if (err.message.includes("replaced: have newer event")) {
            logError('Relay %s says it already has a newer version of this event from the same client (authPubkey: %s)', 
              relay.url, authPubkey);
            logError('This should never happen! Event created_at: %d, tags: %O', 
              eventTemplate.created_at, eventTemplate.tags);
          } else if (err.message.includes("rate-limited")) {
            log('Relay %s rate-limited this publish request', relay.url);
          } else {
            logError('Failed to publish to %s: %O', relay.url, err);
          }
        } else {
          logError('Failed to publish to %s with unknown error: %O', relay.url, err);
        }
        throw err;
      })
    );

    try {
      // Track results for better error handling
      const results = await Promise.allSettled(publishPromises);

      // Check if we had at least one success
      const anySuccess = results.some(r => r.status === 'fulfilled');

      if (anySuccess) {
        // If we had at least one success, consider it a success
        log('Published successfully to at least one relay');

        // Notify sync event listeners of success
        syncEventListeners.forEach(listener => {
          try {
            listener({
              source: 'local',
              success: true,
              changedKeys: Object.keys(data)
            });
          } catch (error) {
            logError('Error in sync event listener: %O', error);
          }
        });
      } else {
        // Real failure - all relays rejected for reasons other than "replaced"
        logError('All publish attempts failed: %O', results);

        // Notify sync event listeners of failure
        syncEventListeners.forEach(listener => {
          try {
            listener({
              source: 'local',
              success: false,
              error: 'All relays rejected the publish',
              changedKeys: Object.keys(data)
            });
          } catch (listenerError) {
            logError('Error in sync event listener: %O', listenerError);
          }
        });

        // Throw a consolidated error
        throw new Error('Failed to publish to any relay');
      }
    } catch (error) {
      logError('Error in publish process: %O', error);
      throw error;
    } finally {
      // Resolve the sync promise
      if (syncResolve) {
        syncResolve();
        syncPromise = null;
        syncResolve = null;
      }
    }
  }

  /**
   * Schedule a sync with debounce
   */
  async function scheduleSync(after) {
    // Create a new sync promise if one doesn't exist
    if (!syncPromise) {
      syncPromise = new Promise(resolve => {
        syncResolve = resolve;
      });
    }
    
    // wait for the local update
    await after;

    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }

    debounceTimer = setTimeout(async () => {
      debounceTimer = null;
      await publishToNostr();
    }, debounce);
  }

  /**
   * Subscribe to updates from other clients
   */
  async function subscribeToUpdates() {
    await ensureRelayConnections();

    connectedRelays.forEach(relay => {
      // Create filter with 'since' parameter if we have a last sync time
      const filter = {
        kinds: [30078],
        "#p": [kvPubkey],
        "#d": [namespace]
      };

      // Only add 'since' if we have a valid last sync time
      if (lastSyncTime > 0) {
        filter.since = lastSyncTime;
      }

      const sub = relay.subscribe([filter], {
        onevent: async (event) => {
          // Skip our own events
          if (event.pubkey === authPubkey) return;

          try {
            // Double-check the namespace (for extra safety)
            const dTag = event.tags.find(tag => tag[0] === 'd');
            if (!dTag || dTag[1] !== namespace) return;

            log('Received event from pubkey: %s', event.pubkey);
            log('Event created_at: %s', new Date(event.created_at * 1000).toISOString());
            log('Event tags: %O', event.tags);

            // Update last sync time to this event's created_at
            if (event.created_at > lastSyncTime) {
              lastSyncTime = event.created_at;
              // Store the last sync time in IndexedDB but don't sync it
              await localSet(LAST_SYNC_KEY, {
                value: lastSyncTime,
                meta: {
                  lastModified: Date.now()
                }
              });
            }

            const decrypted = await decryptData(event.content);
            if (!decrypted) {
              logError('Failed to decrypt event or invalid format: %O', decrypted);
              return;
            }

            log('Received %d entries', Object.keys(decrypted).length);
            log('Decrypted data structure: %O', decrypted);

            // Track which keys have changed for notifications
            const changedKeys = [];

            // Update local storage with remote changes
            for (const [key, entry] of Object.entries(decrypted)) {
              // Skip internal meta keys
              if (key.startsWith('_nkvmeta')) continue;

              const value = entry.value;
              const timestamp = entry.lastModified;

              // Get current value to check timestamp
              const current = await localGet(key);

              // If we have no local value or remote is newer, update
              if (!current || !current.meta ||
                  current.meta.lastModified < timestamp) {

                if (value === null) {
                  // Handle deletion
                  await localDel(key);
                } else {
                  // Handle update
                  await localSet(key, {
                    value,
                    meta: {
                      lastModified: timestamp
                    }
                  });
                }

                // Add to changed keys list
                changedKeys.push(key);
              }
            }

            // Notify listeners of all changes at once
            if (changedKeys.length > 0) {
              for (const key of changedKeys) {
                const entry = await localGet(key);
                const value = entry ? entry.value : null;

                // Notify listeners
                changeListeners.forEach(listener => {
                  try {
                    listener(key, value);
                  } catch (error) {
                    logError('Error in change listener: %O', error);
                  }
                });
              }

              // We don't trigger sync events for remote changes anymore
              // This makes onSync only fire for outgoing publishes
            }
          } catch (error) {
            logError('Error processing remote event: %O', error);
          }
        }
      });
    });
  }

  // Initialize by loading the last sync and publish times, then start subscription
  (async function initialize() {
    try {
      const syncData = await localGet(LAST_SYNC_KEY);
      if (syncData && syncData.value) {
        lastSyncTime = syncData.value;
        log('Loaded last sync time: %s', new Date(lastSyncTime * 1000).toISOString());
      }

    } catch (error) {
      logError('Error loading meta: %O', error);
    }

    // Start subscription
    subscribeToUpdates();
  })();

  return {
    /**
     * Get a value from the store
     * @param {string} key The key to retrieve
     * @returns {Promise<*>} The value or undefined if not found
     */
    async get(key) {
      // Get the entry with metadata
      const entry = await localGet(key);
      // Return only the value to the user, hiding the metadata implementation detail
      return entry ? entry.value : undefined;
    },

    /**
     * Set a value in the store
     * @param {string} key The key to set
     * @param {*} value The value to store
     * @returns {Promise<void>}
     */
    async set(key, value) {
      const timestamp = Date.now();

      // Store the value with metadata (timestamp is an implementation detail)
      const setp = localSet(key, {
        value,
        meta: {
          lastModified: timestamp
        }
      });

      // Schedule a sync
      scheduleSync(setp);
      return setp;
    },

    /**
     * Delete a value from the store
     * @param {string} key The key to delete
     * @returns {Promise<void>}
     */
    async del(key) {
      const delp = localDel(key);
      scheduleSync(delp);
      return delp;
    },

    /**
     * Register a callback for changes from other clients
     * @param {Function} callback Function called with (key, newValue) when changes occur
     * @returns {Function} Function to remove the listener
     */
    onChange(callback) {
      changeListeners.push(callback);
      return () => {
        const index = changeListeners.indexOf(callback);
        if (index !== -1) {
          changeListeners.splice(index, 1);
        }
      };
    },

    /**
     * Register a callback for sync events (both local and remote)
     * @param {Function} callback Function called with sync event details
     * @returns {Function} Function to remove the listener
     */
    onSync(callback) {
      syncEventListeners.push(callback);
      return () => {
        const index = syncEventListeners.indexOf(callback);
        if (index !== -1) {
          syncEventListeners.splice(index, 1);
        }
      };
    },

    /**
     * Close all relay connections
     */
    async close() {
      // Close all relay connections
      for (const relay of connectedRelays) {
        relay.close();
      }
      connectedRelays.length = 0;
    },

    /**
     * Wait for any pending sync to complete
     * @returns {Promise<void>} Promise that resolves when sync is complete
     */
    async sync() {
      // If there's an ongoing sync, wait for it,
      // otherwise resolve immediately
      return syncPromise || Promise.resolve();
    },

    /**
     * Get the cryptographic keys.
     */
    keys() {
      return {
        "auth": {
          "npub": nip19.npubEncode(authPubkey),
          "nsec": nip19.nsecEncode(authSecretKey)
        },
        "kv": {
          "npub": nip19.npubEncode(kvPubkey),
          "nsec": nip19.nsecEncode(kvSecretKey)
        },
      };
    }
  };
}

// Export the createStore function
export { createStore };
