// Import fake-indexeddb polyfill first
import 'fake-indexeddb/auto';

// Import WebSocket implementation for Node.js environment
import { useWebSocketImplementation } from 'nostr-tools/relay';
import WebSocket from 'ws';
useWebSocketImplementation(WebSocket);

// Import necessary tools
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import * as nip19 from 'nostr-tools/nip19';
import { createStore } from '../index.js';

// Test configuration
const TEST_NAMESPACE = 'offline-changes-test-' + Math.floor(Math.random() * 1000000);
const TEST_RELAY = 'wss://relay.damus.io';
const SYNC_DELAY = 2000; // Time to wait for sync to happen

// Use a non-existent relay URL to simulate being offline
const OFFLINE_RELAY = 'wss://non.existent.relay.that.will.fail';
const ONLINE_RELAY = 'wss://relay.damus.io';

async function runTest() {
  console.log(`Starting offline changes test with namespace: ${TEST_NAMESPACE}`);

  // Generate a shared encryption key (kvNsec)
  const kvSecretKey = generateSecretKey();
  const kvNsec = nip19.nsecEncode(kvSecretKey);
  const kvPubkey = getPublicKey(kvSecretKey);

  console.log(`Using shared kvPubkey: ${kvPubkey}`);

  // Create two different auth keys (one for each client)
  const authSecretKey1 = generateSecretKey();
  const authSecretKey2 = generateSecretKey();

  const authPubkey1 = getPublicKey(authSecretKey1);
  const authPubkey2 = getPublicKey(authSecretKey2);

  console.log(`Client 1 authPubkey: ${authPubkey1} (will be offline)`);
  console.log(`Client 2 authPubkey: ${authPubkey2} (will be online)`);

  // Check if DEBUG environment variable is set
  const debugEnabled = process.env.DEBUG !== undefined;

  // Create a store with a real relay connection and isolated database
  const store2 = createStore({
    namespace: TEST_NAMESPACE,
    authNsec: nip19.nsecEncode(authSecretKey2),
    kvNsec: kvNsec,
    relays: [ONLINE_RELAY],
    debounce: 100,
    dbName: `client2-${TEST_NAMESPACE}`, // Unique database name for client 2
    debug: debugEnabled // Enable debug logging based on environment variable
  });

  try {
    // Create a store that will be "offline" with isolated database
    // Use the non-existent relay URL to simulate being offline
    const store1 = createStore({
      namespace: TEST_NAMESPACE,
      authNsec: nip19.nsecEncode(authSecretKey1),
      kvNsec: kvNsec,
      relays: [OFFLINE_RELAY],
      debounce: 100,
      dbName: `client1-${TEST_NAMESPACE}`, // Unique database name for client 1
      debug: debugEnabled // Enable debug logging based on environment variable
    });

    // Test: Make changes while offline
    console.log("\n--- Test: Making changes while offline ---");

    // Make some changes while offline
    const offlineKey1 = 'offline-key-1';
    const offlineKey2 = 'offline-key-2';
    const offlineValue1 = { message: 'Offline change 1' };
    const offlineValue2 = { message: 'Offline change 2' };

    console.log(`Client 1 setting "${offlineKey1}" while offline`);
    await store1.set(offlineKey1, offlineValue1);

    console.log(`Client 1 setting "${offlineKey2}" while offline`);
    await store1.set(offlineKey2, offlineValue2);

    // We don't need to explicitly flush - the library will try to sync automatically
    // and fail because we're offline, but we'll catch the error
    console.log("Changes made while offline, waiting a moment...");
    try {
      // Force a flush to trigger the error
      await store1.flush();
      console.log("❌ Expected an error when trying to publish while offline");
    } catch (error) {
      console.log("✅ Successfully caught expected error when offline:", error.message);
    }

    // Verify the changes are stored locally
    const localValue1 = await store1.get(offlineKey1);
    const localValue2 = await store1.get(offlineKey2);

    console.log("Local values while offline:", {
      [offlineKey1]: localValue1,
      [offlineKey2]: localValue2
    });

    if (localValue1 && localValue2) {
      console.log("✅ Changes were stored locally while offline");
    } else {
      console.log("❌ Changes were not stored locally");
    }

    // Now go online
    console.log("\n--- Going online and syncing offline changes ---");

    // Create a new store with the same keys but online
    // Use the same database name to simulate the same client coming back online
    // But now use a valid relay URL
    const store1Online = createStore({
      namespace: TEST_NAMESPACE,
      authNsec: nip19.nsecEncode(authSecretKey1),
      kvNsec: kvNsec,
      relays: [ONLINE_RELAY],
      debounce: 100,
      dbName: `client1-${TEST_NAMESPACE}`, // Same database name as the offline client
      debug: debugEnabled // Enable debug logging based on environment variable
    });

    // Set up change listener for store2
    const changedKeys = new Set();
    const removeListener = store2.onChange((key, value) => {
      console.log(`Client 2 received change for key "${key}": ${JSON.stringify(value)}`);
      changedKeys.add(key);
    });

    // Verify the offline changes are still available in the new online store
    const onlineValue1 = await store1Online.get(offlineKey1);
    const onlineValue2 = await store1Online.get(offlineKey2);

    console.log("Values after going online:", {
      [offlineKey1]: onlineValue1,
      [offlineKey2]: onlineValue2
    });

    // Make a new change and flush to trigger sync
    const onlineKey = 'online-key';
    const onlineValue = { message: 'Online change' };

    console.log(`Client 1 setting "${onlineKey}" while online`);
    await store1Online.set(onlineKey, onlineValue);

    // The library will automatically try to sync after the debounce period
    console.log("Changes made while online, waiting for debounce...");
    await new Promise(resolve => setTimeout(resolve, 500));

    // Wait for sync to happen
    console.log(`Waiting ${SYNC_DELAY}ms for sync...`);
    await new Promise(resolve => setTimeout(resolve, SYNC_DELAY));

    // Check if Client 2 received the changes
    const receivedValue1 = await store2.get(offlineKey1);
    const receivedValue2 = await store2.get(offlineKey2);
    const receivedValue3 = await store2.get(onlineKey);

    console.log("Client 2 received values:", {
      [offlineKey1]: receivedValue1,
      [offlineKey2]: receivedValue2,
      [onlineKey]: receivedValue3
    });

    if (receivedValue1 && receivedValue2 && receivedValue3) {
      console.log("✅ TEST PASSED: All changes were synced after going online");
    } else {
      console.log("❌ TEST FAILED: Some changes were not synced");
      if (!receivedValue1 || !receivedValue2) {
        console.log("  Offline changes were not synced");
      }
      if (!receivedValue3) {
        console.log("  Online change was not synced");
      }
    }

    // Clean up
    removeListener();

    console.log("\n--- Test completed ---");

  } catch (error) {
    console.error("Test failed with error:", error);
  } finally {
    // Close connections
    await store2.close();

    console.log("Test completed, connections closed.");
    process.exit(0);
  }
}

// Run the test
runTest().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
