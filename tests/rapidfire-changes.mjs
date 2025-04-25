// Import common test utilities
import { setupTestEnvironment } from './common.mjs';

// Import necessary tools
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import * as nip19 from 'nostr-tools/nip19';
import { createStore } from '../index.js';

// Test configuration
const TEST_NAMESPACE = 'rapidfire-test-' + Math.floor(Math.random() * 1000000);
const SYNC_DELAY = 3000; // Time to wait for sync to happen

// Setup test environment
const { relayURLs } = setupTestEnvironment();

// Use console.log for test output
const log = console.log.bind(console);

async function runTest() {
  log(`Starting rapidfire test with namespace: ${TEST_NAMESPACE}`);

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

  log(`Client 1 authPubkey: ${authPubkey1} (will make rapid changes)`);
  log(`Client 2 authPubkey: ${authPubkey2} (will receive changes)`);

  // Create two stores with different debounce settings and isolated databases
  const store1 = createStore({
    namespace: TEST_NAMESPACE,
    authNsec: nip19.nsecEncode(authSecretKey1),
    kvNsec: kvNsec,
    relays: relayURLs,
    debounce: 500, // Use a longer debounce for testing
    dbName: `client1-${TEST_NAMESPACE}` // Unique database name for client 1
  });

  const store2 = createStore({
    namespace: TEST_NAMESPACE,
    authNsec: nip19.nsecEncode(authSecretKey2),
    kvNsec: kvNsec,
    relays: relayURLs,
    debounce: 100, // Use a small debounce for testing
    dbName: `client2-${TEST_NAMESPACE}` // Unique database name for client 2
  });

  // Set up change listener for store2
  const changedKeys = new Set();
  const removeListener = store2.onChange((key, value) => {
    log(`Client 2 received change for key "${key}": ${JSON.stringify(value)}`);
    changedKeys.add(key);
  });

  try {
    // Test: Make rapid changes to multiple keys
    log("\n--- Test: Rapidfire changes to test debounce and queuing ---");

    const baseKey = 'rapid-key-';
    const numKeys = 10;
    const expectedKeys = [];

    log(`Making ${numKeys} rapid changes...`);

    // Define the delay function outside the loop
    const createSmallDelay = (ms) => {
      return new Promise(resolve => setTimeout(resolve, ms));
    };

    // Make rapid changes to multiple keys
    for (let i = 0; i < numKeys; i++) {
      const key = `${baseKey}${i}`;
      expectedKeys.push(key);
      const value = { message: `Value ${i}`, timestamp: Date.now() };

      // Don't await here - we want to make changes rapidly
      store1.set(key, value);

      // Small delay to simulate rapid but not simultaneous changes
      await createSmallDelay(Math.floor(Math.random() * 20));
    }

    // Wait for sync and receive to happen
    log(`Waiting for sync and receive...`);
    await Promise.all([
      store2.onReceive(),
      store1.sync(),
    ]);

    // Check if all keys were received by Client 2
    log(`Client 2 received changes for ${changedKeys.size} keys`);

    let allKeysReceived = true;
    for (const key of expectedKeys) {
      const value = await store2.get(key);
      if (!value) {
        log(`❌ Missing value for key: ${key}`);
        allKeysReceived = false;
      }
    }

    if (allKeysReceived) {
      log("✅ TEST PASSED: All rapidfire changes were successfully synced");
    } else {
      log("❌ TEST FAILED: Some rapidfire changes were not synced");
    }

    // Test: Update the same key multiple times in rapid succession
    log("\n--- Test: Multiple updates to the same key ---");

    const singleKey = 'single-key';
    const finalValue = { message: "Final value", timestamp: Date.now() };

    // Update the same key multiple times rapidly
    for (let i = 0; i < 10; i++) {
      const value = { message: `Intermediate value ${i}`, timestamp: Date.now() };
      await store1.set(singleKey, value);
      // Small delay between updates
      await createSmallDelay(Math.floor(Math.random() * 50));
    }

    // Set the final value
    await store1.set(singleKey, finalValue);

    // Wait for sync and receive to happen
    log(`Waiting for sync and receive...`);
    await Promise.all([
      store2.onReceive(),
      store1.sync(),
    ]);
    
    // Check if Client 2 has the final value
    const receivedValue = await store2.get(singleKey);
    log(`Client 2 final value for "${singleKey}":`, receivedValue);

    if (receivedValue && receivedValue.message === finalValue.message) {
      log("✅ TEST PASSED: Final value was correctly synced");
    } else {
      log("❌ TEST FAILED: Final value was not correctly synced");
    }

    // Test: Updates to the same key that cross debounce boundaries
    log("\n--- Test: Updates crossing debounce boundaries ---");

    const crossDebounceKey = 'cross-debounce-key';
    const finalCrossValue = { message: "Final cross-debounce value", timestamp: Date.now() };
    
    log(`Making 20 updates to the same key with 110ms delay (crosses debounce boundary)...`);
    
    // Track received values for this key
    const receivedCrossValues = [];
    const crossValueListener = store2.onChange((key, value) => {
      if (key === crossDebounceKey) {
        // log(`Client 2 received change for key "${key}": ${JSON.stringify(value)}`);
        receivedCrossValues.push(value);
      }
    });

    // Update the same key multiple times with a delay that will cross debounce boundaries
    for (let i = 0; i < 20; i++) {
      const value = { message: `Cross-debounce value ${i}`, timestamp: Date.now() };
      await store1.set(crossDebounceKey, value);
      // 110ms delay will ensure we cross debounce boundaries
      await createSmallDelay(110);
    }

    // Set the final value
    await store1.set(crossDebounceKey, finalCrossValue);

    // Wait for sync and receive to happen
    log(`Waiting for sync and receive...`);
    await Promise.all([
      store2.onReceive(),
      store1.sync(),
    ]);
    
    // Remove the listener
    crossValueListener();
    
    // Check if Client 2 has the final value
    const receivedCrossValue = await store2.get(crossDebounceKey);
    log(`Client 2 final value for "${crossDebounceKey}":`, receivedCrossValue);
    log(`Client 2 received ${receivedCrossValues.length} updates for this key`);

    if (receivedCrossValue && receivedCrossValue.message === finalCrossValue.message) {
      log("✅ TEST PASSED: Final cross-debounce value was correctly synced");
    } else {
      log("❌ TEST FAILED: Final cross-debounce value was not correctly synced");
    }

    // Clean up
    removeListener();

    log("\n--- All tests completed ---");

  } catch (error) {
    console.error("Test failed with error:", error);
  } finally {
    // Close connections
    await store1.close();
    await store2.close();

    log("Test completed, connections closed.");
    process.exit(0);
  }
}

// Run the test
runTest();
