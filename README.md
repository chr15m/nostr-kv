# nostr-kv

A synchronized key-value store for browser applications that persists data to Nostr.

## Overview

nostr-kv is a browser library that provides a key-value storage system with seamless synchronization across multiple devices. It combines the speed of local IndexedDB storage with the persistence and availability of Nostr's decentralized network.

## Features

- **Local-First with Cloud Sync**: Data is stored locally in IndexedDB and synced to Nostr relays
- **Cross-Device Synchronization**: Access your data from any device with your keys
- **Simple Conflict Resolution**: Last-write-wins strategy for handling concurrent updates
- **Encryption**: Data is encrypted so only authorized clients can read it
- **Namespaced Storage**: Organize data with namespaces to avoid collisions
- **Built on Proven Libraries**: Uses `idb-keyval` for local storage and `nostr-tools` for Nostr integration

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
  kvNsec: 'your-kv-nsec',     // Optional: will be generated if not provided
  relays: ['wss://relay.example.com'], // Optional: will use default relays if not provided
  debounce: 1000, // Optional: milliseconds to wait before syncing rapid changes (default: 500)
  dbName: 'custom-db-name' // Optional: custom IndexedDB database name
});

// Set a value
await store.set('username', 'satoshi');

// Get a value
const username = await store.get('username');
console.log(username); // 'satoshi'

// Delete a value
await store.del('username');

// Listen for changes from other devices
store.onChange((key, newValue) => {
  console.log(`Key ${key} changed to ${newValue}`);
});
```

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
