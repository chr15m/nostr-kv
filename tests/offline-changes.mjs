// Import common test utilities
import { setupTestEnvironment } from './common.mjs';

// Import necessary tools
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import * as nip19 from 'nostr-tools/nip19';
import { createStore } from '../index.js';

// Test configuration
const TEST_NAMESPACE = 'offline-changes-test-' + Math.floor(Math.random() * 1000000);
const SYNC_DELAY = 2000; // Time to wait for sync to happen

// Setup test environment
const { relayURLs } = setupTestEnvironment();

// Use a non-existent relay URL to simulate being offline
const OFFLINE_RELAY = 'wss://non.existent.relay.that.will.fail';

const log = console.log.bind(console);

async function runTest() {
  log(`Starting offline changes test with namespace: ${TEST_NAMESPACE}`);

  // Generate a shared encryption key (kvNsec)
  const kvSecretKey = generateSecretKey();
  const kvNsec = nip19.nsecEncode(kvSecretKey);
  const kvPubkey = getPublicKey(kvSecretKey);

  log(`Using shared kvPubkey: ${kvPubkey}`);

  // Create two different auth keys (one for each client)
  const authSecretKey1 = generateSecretKey();
  const authSecretKey2 = generateSecretKey();

  const authPubkey1 = getPublicKey(authSecretKey1);
  const authPubkey2 = getPublicKey(authSecretKey2);

  log(`Client 1 authPubkey: ${authPubkey1} (will be offline)`);
  log(`Client 2 authPubkey: ${authPubkey2} (will be online)`);

  // Create a store with a real relay connection and isolated database
  const store2 = createStore({
    namespace: TEST_NAMESPACE,
    authNsec: nip19.nsecEncode(authSecretKey2),
    kvNsec: kvNsec,
    relays: relayURLs,
    dbName: `client2-${TEST_NAMESPACE}`, // Unique database name for client 2
    maxRetryCount: 3, // Limit retries during testing
    maxRetryDelay: 5000 // Cap retry delay at 5 seconds for testing
  });
  // Create a store that will be "offline" with isolated database
  // Use the non-existent relay URL to simulate being offline
  const store1 = createStore({
    namespace: TEST_NAMESPACE,
    authNsec: nip19.nsecEncode(authSecretKey1),
    kvNsec: kvNsec,
    relays: [OFFLINE_RELAY],
    dbName: `client1-${TEST_NAMESPACE}`, // Unique database name for client 1
    maxRetryCount: 3, // Limit retries during testing
    maxRetryDelay: 5000 // Cap retry delay at 5 seconds for testing
  });

  // Test: Make changes while offline
  log("\n--- Test: Making changes while offline ---");

  // Make some changes while offline
  const offlineKey1 = 'offline-key-1';
  const offlineKey2 = 'offline-key-2';
  const offlineValue1 = { message: 'Offline change 1' };
  const offlineValue2 = { message: 'Offline change 2' };

  log(`Client 1 setting "${offlineKey1}" while offline`);
  await store1.set(offlineKey1, offlineValue1);

  log(`Client 1 setting "${offlineKey2}" while offline`);
  await store1.set(offlineKey2, offlineValue2);

  // We don't need to explicitly sync - the library will try to sync automatically
  // and fail because we're offline, but it will handle the error internally
  log("Changes made while offline, waiting a moment...");

  // Force a sync to check the return value
  const syncResult = await store1.sync();
  if (syncResult === false) {
    log("✅ Sync correctly returned false when offline");
  } else {
    log("❌ Expected sync to return false when offline");
  }

  // Verify the changes are stored locally
  const localValue1 = await store1.get(offlineKey1);
  const localValue2 = await store1.get(offlineKey2);

  log("Local values while offline:", {
    [offlineKey1]: localValue1,
    [offlineKey2]: localValue2
  });

  if (localValue1 && localValue2) {
    log("✅ Changes were stored locally while offline");
  } else {
    log("❌ Changes were not stored locally");
  }

  // Now go online
  log("\n--- Going online and syncing offline changes ---");

  // Create a new store with the same keys but online
  // Use the same database name to simulate the same client coming back online
  // But now use a valid relay URL
  const store1Online = createStore({
    namespace: TEST_NAMESPACE,
    authNsec: nip19.nsecEncode(authSecretKey1),
    kvNsec: kvNsec,
    relays: relayURLs,
    dbName: `client1-${TEST_NAMESPACE}`, // Same database name as the offline client
    maxRetryCount: 3, // Limit retries during testing
    maxRetryDelay: 5000 // Cap retry delay at 5 seconds for testing
  });

  // Set up change listener for store2
  const changedKeys = new Set();
  const removeListener = store2.onChange((key, value) => {
    log(`Client 2 received change for key "${key}": ${JSON.stringify(value)}`);
    changedKeys.add(key);
  });

  // Verify the offline changes are still available in the new online store
  const onlineValue1 = await store1Online.get(offlineKey1);
  const onlineValue2 = await store1Online.get(offlineKey2);

  log("Values after going online:", {
    [offlineKey1]: onlineValue1,
    [offlineKey2]: onlineValue2
  });

  // Make a new change and flush to trigger sync
  const onlineKey = 'online-key';
  const onlineValue = { message: 'Online change' };

  log(`Client 1 setting "${onlineKey}" while online`);
  await store1Online.set(onlineKey, onlineValue);

  // The library will automatically try to sync after the debounce period
  log("Changes made while online, waiting for debounce...");
  await new Promise(resolve => setTimeout(resolve, 500));

  // Wait for sync to happen
  log(`Waiting for sync...`);
  const syncResults = await Promise.all([
    store1Online.sync(),
    store2.sync()
  ]);

  console.log("syncResults", syncResults);

  if (syncResults[0] === true && syncResults[1] === true) {
    log("✅ Sync successfully published to relays");
  } else {
    log("❌ Sync failed to publish to relays");
  }

  // Additional wait to ensure propagation
  log(`Waiting ${SYNC_DELAY}ms for propagation...`);
  await new Promise(resolve => setTimeout(resolve, SYNC_DELAY));

  // Check if Client 2 received the changes
  const receivedValue1 = await store2.get(offlineKey1);
  const receivedValue2 = await store2.get(offlineKey2);
  const receivedValue3 = await store2.get(onlineKey);

  log("Client 2 received values:", {
    [offlineKey1]: receivedValue1,
    [offlineKey2]: receivedValue2,
    [onlineKey]: receivedValue3
  });

  if (receivedValue1 && receivedValue2 && receivedValue3) {
    log("✅ TEST PASSED: All changes were synced after going online");
  } else {
    log("❌ TEST FAILED: Some changes were not synced");
    if (!receivedValue1 || !receivedValue2) {
      log("  Offline changes were not synced");
    }
    if (!receivedValue3) {
      log("  Online change was not synced");
    }
  }

  // Clean up
  removeListener();

  log("\n--- Test completed ---");

  // Close connections
  await store2.close();

  log("Test completed, connections closed.");
}

// Run the test
runTest();
