// Import common test utilities
import { setupTestEnvironment, log } from './common.mjs';

// Import necessary tools
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import * as nip19 from 'nostr-tools/nip19';
import { createStore } from '../index.js';

// Test configuration
const TEST_NAMESPACE = 'rapidfire-test-' + Math.floor(Math.random() * 1000000);
const SYNC_DELAY = 3000; // Time to wait for sync to happen

// Setup test environment
const { relayURLs } = setupTestEnvironment();

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

  // Check if DEBUG environment variable is set
  const debugEnabled = process.env.DEBUG !== undefined;

  // Create two stores with different debounce settings and isolated databases
  const store1 = createStore({
    namespace: TEST_NAMESPACE,
    authNsec: nip19.nsecEncode(authSecretKey1),
    kvNsec: kvNsec,
    relays: relayURLs,
    debounce: 500, // Use a longer debounce for testing
    dbName: `client1-${TEST_NAMESPACE}`, // Unique database name for client 1
    debug: debugEnabled // Enable debug logging based on environment variable
  });

  const store2 = createStore({
    namespace: TEST_NAMESPACE,
    authNsec: nip19.nsecEncode(authSecretKey2),
    kvNsec: kvNsec,
    relays: relayURLs,
    debounce: 100, // Use a small debounce for testing
    dbName: `client2-${TEST_NAMESPACE}`, // Unique database name for client 2
    debug: debugEnabled // Enable debug logging based on environment variable
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

    // Make rapid changes to multiple keys
    for (let i = 0; i < numKeys; i++) {
      const key = `${baseKey}${i}`;
      expectedKeys.push(key);
      const value = { message: `Value ${i}`, timestamp: Date.now() };

      // Don't await here - we want to make changes rapidly
      store1.set(key, value);

      // Small delay to simulate rapid but not simultaneous changes
      await new Promise(resolve => setTimeout(resolve, 20));
    }

    // Wait for debounce to trigger
    log("Waiting for debounce to trigger...");
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Wait for sync to happen
    log(`Waiting for sync (max ${SYNC_DELAY}ms)...`);
    await new Promise((resolve) => {
      const timeout = setTimeout(resolve, SYNC_DELAY);
      const unsubscribe = store1.onSync(() => {
        clearTimeout(timeout);
        unsubscribe();
        resolve();
      });
    });

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
    for (let i = 0; i < 5; i++) {
      const value = { message: `Intermediate value ${i}`, timestamp: Date.now() };
      await store1.set(singleKey, value);
      // Small delay between updates
      await new Promise(resolve => setTimeout(resolve, 50));
    }

    // Set the final value
    await store1.set(singleKey, finalValue);

    // Wait for sync to happen
    log(`Waiting ${SYNC_DELAY}ms for sync...`);
    await new Promise(resolve => setTimeout(resolve, SYNC_DELAY));

    // Check if Client 2 has the final value
    const receivedValue = await store2.get(singleKey);
    log(`Client 2 final value for "${singleKey}":`, receivedValue);

    if (receivedValue && receivedValue.message === finalValue.message) {
      log("✅ TEST PASSED: Final value was correctly synced");
    } else {
      log("❌ TEST FAILED: Final value was not correctly synced");
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
runTest().catch(err => {
  log("Fatal error:", err);
  process.exit(1);
});
