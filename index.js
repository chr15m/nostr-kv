// Check if we're in a Node.js environment with fake-indexeddb
// The polyfill should be imported before this file
import { get as idbGet, set as idbSet, del as idbDel, createStore as createIdbStore } from 'idb-keyval';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import * as nip04 from 'nostr-tools/nip04';
import { Relay } from 'nostr-tools/relay';
import * as nip19 from 'nostr-tools/nip19';

// Default relays that are known to be reliable
const DEFAULT_RELAYS = [
  'wss://relay.damus.io',
  'wss://relay.nostr.band',
  'wss://nos.lol'
];

// Default debounce time in milliseconds
const DEFAULT_DEBOUNCE = 500;

/**
 * Creates a key-value store that syncs with Nostr
 * @param {Object} options Configuration options
 * @param {string} options.namespace Namespace for the store
 * @param {string} [options.authNsec] Secret key for publishing (will be generated if not provided)
 * @param {string} [options.kvNsec] Secret key for encryption (will be generated if not provided)
 * @param {string[]} [options.relays] Array of relay URLs (defaults to predefined list)
 * @param {number} [options.debounce] Debounce time in ms for rapid updates (default: 500)
 * @returns {Object} Store interface with get, set, del methods
 */
function createStore({
  namespace,
  authNsec,
  kvNsec,
  relays = DEFAULT_RELAYS,
  debounce = DEFAULT_DEBOUNCE
}) {
  if (!namespace) {
    throw new Error('Namespace is required');
  }

  // Generate keys if not provided
  const authSecretKey = authNsec 
    ? (typeof authNsec === 'string' && authNsec.startsWith('nsec') 
        ? nip19.decode(authNsec).data 
        : authNsec)
    : generateSecretKey();
  
  const kvSecretKey = kvNsec
    ? (typeof kvNsec === 'string' && kvNsec.startsWith('nsec') 
        ? nip19.decode(kvNsec).data 
        : kvNsec)
    : generateSecretKey();

  const authPubkey = getPublicKey(authSecretKey);
  const kvPubkey = getPublicKey(kvSecretKey);

  // Create a custom store for this namespace
  const customStore = createIdbStore(`nostr-kv-${namespace}`, 'keyval');
  const localGet = (key) => idbGet(key, customStore);
  const localSet = (key, value) => idbSet(key, value, customStore);
  const localDel = (key) => idbDel(key, customStore);

  // Track connected relays
  const connectedRelays = [];
  let relayConnectPromise = null;

  // Debounce mechanism
  let pendingUpdates = {};
  let debounceTimer = null;

  // Change listeners
  const changeListeners = [];

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
          console.error(`Failed to connect to relay ${url}:`, error);
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
      console.error('Failed to decrypt data:', error);
      return null;
    }
  }

  /**
   * Publish updates to Nostr relays
   */
  async function publishToNostr(updates) {
    await ensureRelayConnections();
    
    if (Object.keys(updates).length === 0) return;

    const timestamp = Date.now();
    const data = {
      keys: Object.keys(updates),
      values: Object.values(updates),
      timestamp: timestamp
    };

    const encryptedContent = await encryptData(data);

    const eventTemplate = {
      kind: 30078,
      created_at: Math.floor(Date.now() / 1000),
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
      relay.publish(signedEvent).catch(err => 
        console.error(`Failed to publish to ${relay.url}:`, err)
      )
    );

    await Promise.allSettled(publishPromises);
  }

  /**
   * Process updates from debounce queue
   */
  function processDebounceQueue() {
    const updates = { ...pendingUpdates };
    pendingUpdates = {};
    debounceTimer = null;
    publishToNostr(updates);
  }

  /**
   * Queue an update for debounced publishing
   */
  function queueUpdate(key, value) {
    pendingUpdates[key] = value;
    
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    
    debounceTimer = setTimeout(processDebounceQueue, debounce);
  }

  /**
   * Subscribe to updates from other clients
   */
  async function subscribeToUpdates() {
    await ensureRelayConnections();

    connectedRelays.forEach(relay => {
      const sub = relay.subscribe([
        {
          kinds: [30078],
          "#p": [kvPubkey],
          "#d": [namespace]
        }
      ], {
        onevent: async (event) => {
          // Skip our own events
          if (event.pubkey === authPubkey) return;

          try {
            // Double-check the namespace (for extra safety)
            const dTag = event.tags.find(tag => tag[0] === 'd');
            if (!dTag || dTag[1] !== namespace) return;

            const decrypted = await decryptData(event.content);
            if (!decrypted || !decrypted.keys || !decrypted.values) return;

            // Update local storage with remote changes
            for (let i = 0; i < decrypted.keys.length; i++) {
              const key = decrypted.keys[i];
              const value = decrypted.values[i];
              
              // Get current value to check timestamp
              const current = await localGet(key);
              
              // If we have no local value or remote is newer, update
              if (!current || !current.meta || 
                  current.meta.lastModified < decrypted.timestamp) {
                
                if (value === null) {
                  // Handle deletion
                  await localDel(key);
                } else {
                  // Handle update
                  await localSet(key, {
                    value,
                    meta: {
                      lastModified: decrypted.timestamp
                    }
                  });
                }
                
                // Notify listeners
                changeListeners.forEach(listener => {
                  try {
                    listener(key, value);
                  } catch (error) {
                    console.error('Error in change listener:', error);
                  }
                });
              }
            }
          } catch (error) {
            console.error('Error processing remote event:', error);
          }
        }
      });
    });
  }

  // Start subscription
  subscribeToUpdates();

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
      await localSet(key, {
        value,
        meta: {
          lastModified: timestamp
        }
      });

      // Only send the actual value to Nostr, metadata is handled internally
      queueUpdate(key, value);
    },

    /**
     * Delete a value from the store
     * @param {string} key The key to delete
     * @returns {Promise<void>}
     */
    async del(key) {
      await localDel(key);
      queueUpdate(key, null);
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
     * Get the public keys used by this store
     * @returns {Object} Object containing authPubkey and kvPubkey
     */
    getPublicKeys() {
      return {
        authPubkey,
        kvPubkey
      };
    },

    /**
     * Get the secret keys used by this store (careful with this!)
     * @returns {Object} Object containing authSecretKey and kvSecretKey
     */
    getSecretKeys() {
      return {
        authSecretKey: nip19.nsecEncode(authSecretKey),
        kvSecretKey: nip19.nsecEncode(kvSecretKey)
      };
    },

    /**
     * Force immediate sync of any pending updates
     * @returns {Promise<void>}
     */
    async flush() {
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      
      await processDebounceQueue();
    },

    /**
     * Close all relay connections
     */
    async close() {
      // Flush any pending updates
      await this.flush();
      
      // Close all relay connections
      for (const relay of connectedRelays) {
        relay.close();
      }
      connectedRelays.length = 0;
    }
  };
}

// Export the createStore function
export { createStore };
