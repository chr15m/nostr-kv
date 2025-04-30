// Import common test utilities
import { setupTestEnvironment, logTestStart } from './common.mjs';

// Import necessary tools
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import * as nip19 from 'nostr-tools/nip19';
import { createStore } from '../index.js';
import assert from 'node:assert/strict'; // Import assert

// Test configuration
const TEST_NAMESPACE = 'offline-changes-test-' + Math.floor(Math.random() * 1000000);
const SYNC_DELAY = 2000; // Time to wait for sync to happen

// Setup test environment
const { relayURLs } = setupTestEnvironment();

// Use a non-existent relay URL to simulate being offline
const OFFLINE_RELAY = 'wss://non.existent.relay.that.will.fail';

const log = console.log.bind(console);

async function runTest() {
  logTestStart(import.meta.url); // Log the start of the test
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

  let store1Online = null; // Define here for finally block

  try {
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

    // Force a sync to check the return value
    const syncResult = await store1.sync();
    assert.strictEqual(syncResult, false, "❌ Expected sync to return false when offline");
    log("✅ Sync correctly returned false when offline");


    // Verify the changes are stored locally
    const localValue1 = await store1.get(offlineKey1);
    const localValue2 = await store1.get(offlineKey2);

    log("Local values while offline:", {
      [offlineKey1]: localValue1,
      [offlineKey2]: localValue2
    });

    assert.ok(localValue1, `❌ Offline change for ${offlineKey1} was not stored locally`);
    assert.ok(localValue2, `❌ Offline change for ${offlineKey2} was not stored locally`);
    assert.deepStrictEqual(localValue1, offlineValue1, `❌ Incorrect local value for ${offlineKey1}`);
    assert.deepStrictEqual(localValue2, offlineValue2, `❌ Incorrect local value for ${offlineKey2}`);
    log("✅ Changes were stored locally while offline");


    // Now go online
    log("\n--- Going online and syncing offline changes ---");

    // Close the offline store first to release the DB lock
    await store1.close();
    log("Offline store closed.");

    // Create a new store with the same keys but online
    // Use the same database name to simulate the same client coming back online
    // But now use a valid relay URL
    store1Online = createStore({ // Assign to the variable defined outside try
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
    assert.ok(onlineValue1, `❌ Offline change for ${offlineKey1} missing after going online`);
    assert.ok(onlineValue2, `❌ Offline change for ${offlineKey2} missing after going online`);
    assert.deepStrictEqual(onlineValue1, offlineValue1, `❌ Incorrect value for ${offlineKey1} after going online`);
    assert.deepStrictEqual(onlineValue2, offlineValue2, `❌ Incorrect value for ${offlineKey2} after going online`);
    log("✅ Offline changes persisted locally after going online");


    // Make a new change and flush to trigger sync
    const onlineKey = 'online-key';
    const onlineValue = { message: 'Online change' };

    log(`Client 1 setting "${onlineKey}" while online`);
    await store1Online.set(onlineKey, onlineValue);

    // Wait for sync to happen AND for store2 to receive the event
    log(`Waiting for sync and receive...`);
    const [_syncResult, _receiveResult] = await Promise.all([
      store1Online.sync(),
      store2.onReceive() // Wait for store2 to process the incoming event
    ]);

    log("store1Online sync result:", _syncResult);
    assert.strictEqual(_syncResult, true, "❌ Sync failed to publish to relays after going online");
    log("✅ Sync successfully published to relays after going online");
    log("✅ Store 2 received event");

    // Now it should be safe to check if Client 2 received the changes
    const receivedValue1 = await store2.get(offlineKey1);
    const receivedValue2 = await store2.get(offlineKey2);
    const receivedValue3 = await store2.get(onlineKey);

    log("Client 2 received values:", {
      [offlineKey1]: receivedValue1,
      [offlineKey2]: receivedValue2,
      [onlineKey]: receivedValue3
    });

    assert.ok(receivedValue1, `❌ Client 2 did not receive offline change for ${offlineKey1}`);
    assert.ok(receivedValue2, `❌ Client 2 did not receive offline change for ${offlineKey2}`);
    assert.ok(receivedValue3, `❌ Client 2 did not receive online change for ${onlineKey}`);
    assert.deepStrictEqual(receivedValue1, offlineValue1, `❌ Client 2 received incorrect value for ${offlineKey1}`);
    assert.deepStrictEqual(receivedValue2, offlineValue2, `❌ Client 2 received incorrect value for ${offlineKey2}`);
    assert.deepStrictEqual(receivedValue3, onlineValue, `❌ Client 2 received incorrect value for ${onlineKey}`);
    log("✅ TEST PASSED: All changes were synced after going online");


    // Clean up listener
    removeListener();

    log("\n--- Test completed ---");

  } catch (error) {
    console.error("Test failed with error:", error);
    // Re-throw the error to ensure non-zero exit code
    throw error;
  } finally {
    // Close connections
    await store2.close();
    if (store1Online) { // Check if store1Online was initialized
      await store1Online.close();
    } else {
      // If store1Online wasn't created (e.g., error during offline phase), close original store1
      await store1.close();
    }

    log("Test completed, connections closed.");
    // No need for process.exit(0); successful completion implies exit code 0
  }
}

// Run the test
runTest();
