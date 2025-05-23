# nostr-kv

A synchronized key-value store for browser applications that persists data to Nostr.

## Overview

nostr-kv is a browser library that provides a key-value storage system with seamless synchronization across multiple devices. It combines the speed of local IndexedDB storage with the persistence and availability of Nostr's decentralized network. It implements [NIP-78](https://github.com/nostr-protocol/nips/blob/master/78.md) for arbitrary custom app data storage.

## Features

- **Local-First with Cloud Sync**: Data is stored locally in IndexedDB and synced to Nostr relays
- **Cross-Device Synchronization**: Access your data from any device with your keys
- **Simple Conflict Resolution**: Last-write-wins strategy for handling concurrent updates
- **Encryption**: Data is encrypted so only authorized clients can read it
- **Namespaced Storage**: Organize data with namespaces to avoid collisions
- **Built on Proven Libraries**: Uses `idb-keyval` for local storage and `nostr-tools` for Nostr integration

## Limitations

- The fastest you can do sync'ed updates is 1 every second because Nostr event time is a unix timestamp (debounce handles this automatically).
- Total data size in the kv should be smaller than ~50kb or relays will time-out when you try to write.
- Relays will rate-limit updates that happen too frequently, independently of the 1 second limit above.
- Updates can take multiple seconds to propagate on busy relays.

Overall you shouldn't expect to store large amounts of data or fast propagation times. Eventual consensus of small datasets.

## How It Works

1. When you save data, it's stored locally in IndexedDB
2. The library adds metadata like "last-modified" timestamps
3. Data is published to Nostr relays as type 30078 events (as defined in [NIP-78](https://github.com/nostr-protocol/nips/blob/master/78.md))
4. Other devices with the same keys subscribe to these events
5. When they receive updates, they update their local IndexedDB
6. Content is encrypted so only devices with the shared key can read it

## Security Model

- **Publishing Key (auth_nsec)**: Each device/client has its own key for publishing events
- **Shared Encryption Key (kv_nsec)**: A shared key ensures only authorized clients can decrypt the data

## Installation

```bash
npm install nostr-kv
```

## Basic Usage

```javascript
import { createStore } from 'nostr-kv';

// Initialize with namespace (keys and relays are optional)
const store = createStore({
  namespace: 'my-app',
  authNsec: 'your-auth-nsec', // Optional: will be generated if not provided
  kvNsec: 'your-kv-nsec',     // Optional: will be generated if not provided - share across devices to sync
  relays: ['wss://relay.example.com'], // Optional: will use default relays if not provided
  debounce: 1000, // Optional: milliseconds to wait before syncing rapid changes (default: 1010)
  dbName: 'custom-db-name', // Optional: custom IndexedDB database name
  maxRetryCount: 3, // Optional: max number of retry attempts (0 = retry forever, default: 0)
  maxRetryDelay: 60000 // Optional: maximum delay between retries in ms (default: 60000)
});

// Set a value
await store.set('username', 'satoshi');

// Get a value
const username = await store.get('username');
console.log(username); // 'satoshi'

// Delete a value
await store.del('username');

// Listen for changes from other devices (callback approach)
const removeListener = store.onChange((key, newValue) => {
  console.log(`Key ${key} changed to ${newValue}`);
});

// Later, when you want to stop listening:
removeListener();

// Alternative: Promise-based approach to wait for the next change
const change = await store.onChange();
console.log(`Key ${change.key} changed to:`, change.value);

// Wait for any incoming event from relays
await store.onReceive();
console.log('Received an update from a relay');

// Force a sync and check if it was successful
const syncSuccessful = await store.sync();
if (syncSuccessful) {
  console.log('Successfully synced with relays');
} else {
  console.log('Failed to sync with relays (possibly offline)');
}

// Access the keys used by this store (as NIP-19 encoded strings)
const keys = store.keys();
console.log(`Auth npub: ${keys.auth.npub}, KV npub: ${keys.kv.npub}`);
console.log(`Auth nsec: ${keys.auth.nsec}, KV nsec: ${keys.kv.nsec}`);
```

## API Reference

### Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `namespace` | string | (required) | Namespace for the store |
| `authNsec` | string | (auto-generated) | Secret key for publishing events |
| `kvNsec` | string | (auto-generated) | Secret key for encryption |
| `relays` | string[] | Default relays | Array of relay URLs |
| `debounce` | number | 1010 | Debounce time in ms for rapid updates |
| `dbName` | string | `nostr-kv-${namespace}` | Custom IndexedDB database name |
| `maxRetryCount` | number | 0 | Max retry attempts (0 = retry forever) |
| `maxRetryDelay` | number | 60000 | Maximum delay between retries in ms |

### Methods

| Method | Description |
|--------|-------------|
| `get(key)` | Get a value from the store |
| `set(key, value)` | Set a value in the store |
| `del(key)` | Delete a value from the store |
| `onChange([callback])` | Register a callback for changes or get a Promise for the next change |
| `onReceive()` | Get a Promise that resolves when any data is received from relays |
| `sync()` | Wait for pending sync to complete, returns boolean indicating success |
| `close()` | Close all relay connections |
| `keys()` | Get the cryptographic keys used by this store |

## Benefits

- **No Central Server**: Your data isn't locked into a proprietary cloud service
- **User-Controlled**: Users provide their own Nostr keys and choose which relays to use
- **Offline-Capable**: Works offline with local-first approach
- **Privacy-Focused**: Data is encrypted end-to-end

## Use Cases

- User preferences and settings across multiple devices
- Document synchronization for collaborative applications
- Personal data that follows users across different clients

## License

MIT
