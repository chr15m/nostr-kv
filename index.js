import { get as idbGet, set as idbSet, del as idbDel, entries as idbEntries, createStore as createIdbStore } from 'idb-keyval';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import * as nip04 from 'nostr-tools/nip04';
import { SimplePool } from 'nostr-tools/pool';
import * as nip19 from 'nostr-tools/nip19';
import createDebug from 'debug';

// TODO: shorten names from value to v and lastModified to t
// TODO: del should set a special key "d" and v to nil, rather than actually deleting
// TODO: lastSyncTime should be updated after successful processing not before
// TODO: add "dirty" flag to the datastore and set on set, unset on successful sync
// TODO: crunch the data down with msgpack
// TODO: remove idb-keyval to use localStorage
// TODO: fail to set() if the msgpack raw size gets above configurable value
// TODO: investigate initial sync race: local changes on startup, might be published before merging recent remote changes received during initial connect

// TODO: make the publishing thread clearer and more sequential - single fn with delays and flag checks
// TODO: more robust testing of the publishing thread to check for race conditions and deadlocks

// TODO: automatically re-sync when window.online event happens and at startup
// TODO: tests should crash on fail - use something like tape?
// TODO: update on leading edge of the debounce and every second after that? option to throttle?
// TODO: add more timeout races to tests so we can sensibly time out
// TODO: put all the debounce and sync timers, resolvers, into one structure

// Default relays that are known to be reliable
const DEFAULT_RELAYS = [
  'wss://relay.damus.io',
  'wss://relay.nostr.band',
  // 'wss://nos.lol'
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
 * @param {number} [options.maxRetryCount] Max number of retry attempts (0 = retry forever, default: 0)
 * @param {number} [options.maxRetryDelay] Maximum delay between retries in ms (default: 60000)
 * @returns {Object} Store interface with get, set, del methods
 */
function createStore({
  namespace,
  authNsec,
  kvNsec,
  relays = DEFAULT_RELAYS,
  debounce = DEFAULT_DEBOUNCE,
  dbName = null,
  maxRetryCount = 0,
  maxRetryDelay = 60000,
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
  const log = createDebug(`nostr-kv:store:${namespace}:${shortAuthKey}`);
  const logError = createDebug(`nostr-kv:store:${namespace}:${shortAuthKey}:error`);

  log("DEBUG ENABLED");
  logError("DEBUG ENABLED");

  // Create a custom store for this namespace
  const dbNameToUse = dbName || `nostr-kv-${namespace}`;
  const customStore = createIdbStore(dbNameToUse, 'keyval');
  const localGet = (key) => idbGet(key, customStore);
  const localSet = (key, value) => idbSet(key, value, customStore);
  const localDel = (key) => idbDel(key, customStore);

  // Create a SimplePool for relay management
  const pool = new SimplePool();

  // Debounce mechanism for sync
  let debounceTimer = null;
  let syncPromise = null;
  let syncResolve = null;
  let receiveResolve = null;

  // Variables for retry mechanism
  let publishRetryCount = 0;
  const BASE_RETRY_DELAY = 1000; // 1 second initial delay

  // Change listeners
  const changeListeners = [];

  // Special meta keys (stored in a special meta key that won't be synced)
  const LAST_SYNC_KEY = '_nkvmeta_lastSync';
  let lastSyncTime = 0;

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
   * Publish all data to Nostr relays using SimplePool
   */
  async function publishToNostr() {
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

    try {
      // Use SimplePool to publish to all relays
      const publishPromise = pool.publish(relays, signedEvent);

      // Wait for at least one relay to accept the event
      await Promise.any(publishPromise).catch(err => {
        logError('All publish attempts failed: %O', err);
        throw new Error('Failed to publish to any relay');
      });

      log('Published successfully to at least one relay');

      // Reset retry count on success
      publishRetryCount = 0;

      // Resolve the sync promise with success=true
      if (syncResolve) {
        syncResolve(true);
        syncPromise = null;
        syncResolve = null;
      }
    } catch (error) {
      logError('Error in publish process: %O', error);

      // Implement exponential backoff for retries
      publishRetryCount++;

      // Check if we should retry (either retry forever or under max count)
      const shouldRetry = maxRetryCount === 0 || publishRetryCount < maxRetryCount;

      if (shouldRetry) {
        // Calculate delay with exponential backoff, capped at maxRetryDelay
        const retryDelay = Math.min(
          BASE_RETRY_DELAY * Math.pow(2, publishRetryCount - 1),
          maxRetryDelay
        );

        logError(`Scheduling retry #${publishRetryCount} in ${retryDelay}ms`);

        // Schedule retry
        setTimeout(publishToNostr, retryDelay);
      } else {
        logError(`Max retry attempts (${maxRetryCount}) reached. Giving up.`);
        publishRetryCount = 0;

        // Resolve the sync promise with success=false
        if (syncResolve) {
          syncResolve(false);
          syncPromise = null;
          syncResolve = null;
        }
      }
    }
  }

  /**
   * Subscribe to updates from other clients using SimplePool
   */
  async function subscribeToUpdates() {
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

    // Subscribe to all relays at once using SimplePool
    pool.subscribeMany(relays, [filter], {
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
            await localSet(LAST_SYNC_KEY, Date.now());
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

            log('Getting current for key:', key);
            // Get current value to check timestamp
            const current = await localGet(key);

            log('Got current for key ', key, "=", current);
            log('Entry received for key ', key, "=", entry);
            log('Has meta?', current && current.meta);
            log('lastModified', current && current.meta && current.meta.lastModified, timestamp);
            log('Is later?', current && current.meta && current.meta.lastModified < timestamp);

            // If we have no local value or remote is newer, update
            if (!current || !current.meta ||
                current.meta.lastModified < timestamp) {

              if (value === null) {
                // Handle deletion
                await localDel(key);
              } else {
                log("LOCAL UPDATE");
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

          log("changedKeys", changedKeys);

          // Notify listeners of all changes at once
          if (changedKeys.length > 0) {
            for (const key of changedKeys) {
              const entry = await localGet(key);
              const value = entry ? entry.value : null;

              // Notify listeners
              changeListeners.forEach(listener => {
                log("telling listener", key, value);
                listener(key, value);
              });
            }
          }
        } catch (error) {
          logError('Error processing remote event: %O', error);
        }
        if (receiveResolve) {
          receiveResolve();
          receiveResolve = null;
        }
      }
    });
  }

  // Initialize by loading the last sync and publish times, then start subscription
  (async function initialize() {
    lastSyncTime = await localGet(LAST_SYNC_KEY) || 0;
    log('Loaded last sync time: %s', new Date(lastSyncTime * 1000).toISOString());
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
      const entry = {
        value,
        meta: {
          lastModified: Date.now()
        }
      };

      log("set", key, "to", entry);
      // Store the value with metadata
      const setp = localSet(key, entry);

      // Schedule a sync
      scheduleSync(setp);
      return setp;
    },

    /**
     * Delete a value from the store
     * @param {string} key The key to delete
     * @returns {Promise<void>}
     */
    // TODO: delete should insert a special key instead of value
    async del(key) {
      const delp = localDel(key);
      scheduleSync(delp);
      return delp;
    },

    /**
     * Register a callback for changes from other clients or wait for the next change
     * @param {Function} [callback] Optional function called with (key, newValue) when changes occur
     * @returns {Function|Promise} Function to remove the listener or Promise that resolves with the next change
     */
    onChange(callback) {
      // If callback is provided, add it to listeners and return removal function
      if (typeof callback === 'function') {
        changeListeners.push(callback);
        return () => {
          const index = changeListeners.indexOf(callback);
          if (index !== -1) {
            changeListeners.splice(index, 1);
          }
        };
      }

      // If no callback is provided, return a promise that resolves on next change
      return new Promise(resolve => {
        const oneTimeCallback = (key, value) => {
          // Remove this listener immediately after it's called
          const index = changeListeners.indexOf(oneTimeCallback);
          if (index !== -1) {
            changeListeners.splice(index, 1);
          }
          // Resolve with the change information
          resolve({ key, value });
        };

        // Add the one-time callback to listeners
        changeListeners.push(oneTimeCallback);
      });
    },

    /**
     * Get a promise that resolves when we receive anything from a relay.
     * @returns {Promise} A promise that resolves when any
     */
    async onReceive() {
      return new Promise(resolve => {
        receiveResolve = resolve;
      });
    },

    /**
     * Close all relay connections
     */
    async close() {
      // Close all relay connections using SimplePool
      return pool.close(relays);
    },

    /**
     * Wait for any pending sync to complete
     * @returns {Promise<void>} Promise that resolves when sync is complete - resolves false if there is unsync'ed data (e.g. disconnected).
     */
    async sync() {
      return syncPromise || Promise.resolve(true);
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
