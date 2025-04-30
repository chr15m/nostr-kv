// Import common test utilities
import { setupTestEnvironment, logTestStart } from './common.mjs';

// Import necessary tools
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import * as nip19 from 'nostr-tools/nip19';
import { createStore } from '../index.js';
import assert from 'node:assert/strict'; // Import assert

// Test configuration
const TEST_NAMESPACE = 'offline-test-' + Math.floor(Math.random() * 1000000);
const SYNC_DELAY = 2000; // Time to wait for sync to happen

// Setup test environment
const { relayURLs } = setupTestEnvironment();

// Use console.log for test output
const log = console.log.bind(console);

async function runTest() {
  logTestStart(import.meta.url); // Log the start of the test
  log(`Starting offline test with namespace: ${TEST_NAMESPACE}`);

  // Generate a shared encryption key (kvNsec)
  const kvSecretKey = generateSecretKey();
  const kvNsec = nip19.nsecEncode(kvSecretKey);
  const kvPubkey = getPublicKey(kvSecretKey);

  log(`Using shared kvPubkey: ${kvPubkey}`);

  // Create three different auth keys (one for each client)
  const authSecretKey1 = generateSecretKey();
  const authSecretKey2 = generateSecretKey();
  const authSecretKey3 = generateSecretKey();

  const authPubkey1 = getPublicKey(authSecretKey1);
  const authPubkey2 = getPublicKey(authSecretKey2);
  const authPubkey3 = getPublicKey(authSecretKey3);

  log(`Client 1 authPubkey: ${authPubkey1}`);
  log(`Client 2 authPubkey: ${authPubkey2}`);
  log(`Client 3 authPubkey: ${authPubkey3} (will be offline)`);

  // Create three stores with the same kvNsec but different authNsec and isolated databases
  const store1 = createStore({
    namespace: TEST_NAMESPACE,
    authNsec: nip19.nsecEncode(authSecretKey1),
    kvNsec: kvNsec,
    relays: relayURLs,
    dbName: `client1-${TEST_NAMESPACE}`, // Unique database name for client 1
    maxRetryCount: 3, // Limit retries during testing
    maxRetryDelay: 5000 // Cap retry delay at 5 seconds for testing
  });

  const store2 = createStore({
    namespace: TEST_NAMESPACE,
    authNsec: nip19.nsecEncode(authSecretKey2),
    kvNsec: kvNsec,
    relays: relayURLs,
    dbName: `client2-${TEST_NAMESPACE}`, // Unique database name for client 2
    maxRetryCount: 3, // Limit retries during testing
    maxRetryDelay: 5000 // Cap retry delay at 5 seconds for testing
  });

  // We'll create store3 later to simulate it being offline initially
  let store3 = null; // Define store3 here

  try {
    // Test: Client 3 is offline while Client 1 and Client 2 make changes
    log("\n--- Test: Client is offline for multiple updates ---");

    // Client 1 sets a value
    const key1 = 'key1-' + Date.now();
    const value1 = { message: 'Update 1 from Client 1' };

    log(`Client 1 setting "${key1}" to:`, value1);
    await store1.set(key1, value1);

    // Wait a moment
    await new Promise(resolve => setTimeout(resolve, 500));

    // Client 2 sets a value
    const key2 = 'key2-' + Date.now();
    const value2 = { message: 'Update 2 from Client 2' };

    log(`Client 2 setting "${key2}" to:`, value2);
    await store2.set(key2, value2);

    // Wait a moment
    await new Promise(resolve => setTimeout(resolve, 500));

    // Client 1 updates a value
    const key3 = 'key3-' + Date.now();
    const value3 = { message: 'Update 3 from Client 1' };

    log(`Client 1 setting "${key3}" to:`, value3);
    await store1.set(key3, value3);

    // Wait for sync between Client 1 and Client 2
    log(`Waiting for sync between online clients...`);
    const onlinesync = await Promise.all([
      store1.sync(),
      store2.sync()
    ]);

    assert.ok(onlinesync[0] === true && onlinesync[1] === true, "❌ Sync failed to publish to relays for online clients");
    log("✅ Sync successfully published to relays for online clients");


    // Additional wait to ensure propagation
    await new Promise(resolve => setTimeout(resolve, SYNC_DELAY));

    // Verify Client 1 and Client 2 are in sync
    const client1Key1 = await store1.get(key1);
    const client1Key2 = await store1.get(key2);
    const client1Key3 = await store1.get(key3);

    const client2Key1 = await store2.get(key1);
    const client2Key2 = await store2.get(key2);
    const client2Key3 = await store2.get(key3);

    log("Client 1 values:", { key1: client1Key1, key2: client1Key2, key3: client1Key3 });
    log("Client 2 values:", { key1: client2Key1, key2: client2Key2, key3: client2Key3 });

    assert.ok(client1Key1 && client1Key2 && client1Key3, "❌ Client 1 missing some values");
    assert.ok(client2Key1 && client2Key2 && client2Key3, "❌ Client 2 missing some values");
    assert.deepStrictEqual(client1Key1, client2Key1, "❌ Client 1 and 2 have different values for key1");
    assert.deepStrictEqual(client1Key2, client2Key2, "❌ Client 1 and 2 have different values for key2");
    assert.deepStrictEqual(client1Key3, client2Key3, "❌ Client 1 and 2 have different values for key3");
    log("✅ Online clients are in sync with each other");


    // Now bring Client 3 online
    log("\n--- Bringing offline client online ---");

    // Create store3 now - it missed all previous updates while "offline"
    store3 = createStore({ // Assign to the previously defined variable
      namespace: TEST_NAMESPACE,
      authNsec: nip19.nsecEncode(authSecretKey3),
      kvNsec: kvNsec,
      relays: relayURLs,
      dbName: `client3-${TEST_NAMESPACE}`, // Unique database name for client 3
      maxRetryCount: 3, // Limit retries during testing
      maxRetryDelay: 5000 // Cap retry delay at 5 seconds for testing
    });

    // Set up change listener for store3
    let changeCount = 0;
    const receivedKeys = new Set(); // Track received keys
    const removeListener = store3.onChange((key, value) => {
      log(`Client 3 received change for key "${key}": ${JSON.stringify(value)}`);
      receivedKeys.add(key);
      changeCount++;
    });

    // Wait for Client 3 to sync and catch up
    log(`Waiting for offline client to catch up...`);

    // Wait for at least one receive event or timeout after a while
    const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout waiting for store3.onReceive()')), SYNC_DELAY * 3));
    try {
      await Promise.race([
        store3.onReceive(), // Wait for the first event to arrive
        timeoutPromise
      ]);
      log("Client 3 received at least one event.");
    } catch (err) {
      log("Warning: Timed out waiting for the first event from store3, proceeding anyway...");
      // Don't fail the test here, maybe it just took longer
    }


    // Additional wait to ensure all changes are processed
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Verify Client 3 caught up with all changes
    const client3Key1 = await store3.get(key1);
    const client3Key2 = await store3.get(key2);
    const client3Key3 = await store3.get(key3);

    log("Client 3 values after coming online:", {
      key1: client3Key1,
      key2: client3Key2,
      key3: client3Key3
    });
    log(`Client 3 received ${changeCount} change notifications for keys: ${Array.from(receivedKeys).join(', ')}`);

    assert.ok(client3Key1, `❌ TEST FAILED: Offline client did not receive value for ${key1}`);
    assert.ok(client3Key2, `❌ TEST FAILED: Offline client did not receive value for ${key2}`);
    assert.ok(client3Key3, `❌ TEST FAILED: Offline client did not receive value for ${key3}`);
    assert.deepStrictEqual(client3Key1, value1, `❌ TEST FAILED: Offline client received incorrect value for ${key1}`);
    assert.deepStrictEqual(client3Key2, value2, `❌ TEST FAILED: Offline client received incorrect value for ${key2}`);
    assert.deepStrictEqual(client3Key3, value3, `❌ TEST FAILED: Offline client received incorrect value for ${key3}`);
    log("✅ TEST PASSED: Offline client successfully caught up with all changes");


    // Clean up listener
    removeListener();

    log("\n--- Test completed ---");

  } catch (error) {
    console.error("Test failed with error:", error);
    // Re-throw the error to ensure non-zero exit code
    throw error;
  } finally {
    // Close connections
    await store1.close();
    await store2.close();
    if (store3) { // Check if store3 was initialized before closing
      await store3.close();
    }

    log("Test completed, connections closed.");
    // No need for process.exit(0); successful completion implies exit code 0
  }
}

// Run the test
runTest();
