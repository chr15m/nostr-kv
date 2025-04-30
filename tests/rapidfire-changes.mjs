// Import common test utilities
import { setupTestEnvironment, logTestStart } from './common.mjs';

// Import necessary tools
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import * as nip19 from 'nostr-tools/nip19';
import { createStore } from '../index.js';
import assert from 'node:assert/strict'; // Import assert

// Test configuration
const TEST_NAMESPACE = 'rapidfire-test-' + Math.floor(Math.random() * 1000000);
const SYNC_DELAY = 3000; // Time to wait for sync to happen
const DEBOUNCE_TIME = 1100; // Use a specific debounce time > 1s

// Setup test environment
const { relayURLs } = setupTestEnvironment();

// Use console.log for test output
const log = console.log.bind(console);

async function runTest() {
  logTestStart(import.meta.url); // Log the start of the test
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
    debounce: DEBOUNCE_TIME, // Use a specific debounce for testing
    dbName: `client1-${TEST_NAMESPACE}` // Unique database name for client 1
  });

  const store2 = createStore({
    namespace: TEST_NAMESPACE,
    authNsec: nip19.nsecEncode(authSecretKey2),
    kvNsec: kvNsec,
    relays: relayURLs,
    debounce: 100, // Receiver debounce doesn't matter much here
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
    const numKeys = 5; // Reduced number for faster testing
    const expectedKeys = [];
    const expectedValues = {};

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
      expectedValues[key] = value;

      // Don't await here - we want to make changes rapidly
      store1.set(key, value);

      // Small delay to simulate rapid but not simultaneous changes
      await createSmallDelay(Math.floor(Math.random() * 20));
    }

    // Wait for sync and receive to happen
    log(`Waiting for sync and receive (debounce: ${DEBOUNCE_TIME}ms)...`);
    const syncPromise1 = store1.sync(); // Get the promise representing the sync operation
    const receivePromise2 = store2.onReceive(); // Wait for the receiver to get *something*

    // Wait for the sync to complete and the receiver to get at least one event
    await Promise.all([syncPromise1, receivePromise2]);
    log("Initial sync/receive completed.");

    // Add extra delay to ensure all events are processed by store2
    await new Promise(resolve => setTimeout(resolve, SYNC_DELAY));

    // Check if all keys were received by Client 2
    log(`Client 2 received changes for ${changedKeys.size} keys: ${Array.from(changedKeys).join(', ')}`);

    let allKeysReceived = true;
    for (const key of expectedKeys) {
      const value = await store2.get(key);
      if (!value) {
        log(`❌ Missing value for key: ${key}`);
        allKeysReceived = false;
      } else {
        // Also check the value content
        assert.deepStrictEqual(value, expectedValues[key], `❌ Incorrect value received for key: ${key}`);
      }
    }

    assert.ok(allKeysReceived, "❌ TEST FAILED: Some rapidfire changes were not synced or had incorrect values");
    log("✅ TEST PASSED: All rapidfire changes were successfully synced with correct values");


    // Test: Update the same key multiple times in rapid succession (within debounce period)
    log("\n--- Test: Multiple updates to the same key (within debounce) ---");

    const singleKey = 'single-key';
    const finalValue = { message: "Final value", timestamp: Date.now() };
    const intermediateValues = [];

    // Update the same key multiple times rapidly
    for (let i = 0; i < 5; i++) { // Reduced number
      const value = { message: `Intermediate value ${i}`, timestamp: Date.now() };
      intermediateValues.push(value);
      await store1.set(singleKey, value);
      // Small delay between updates, well within debounce
      await createSmallDelay(Math.floor(Math.random() * 50));
    }

    // Set the final value just before the debounce timer would fire
    await store1.set(singleKey, finalValue);

    // Wait for sync and receive to happen
    log(`Waiting for sync and receive (debounce: ${DEBOUNCE_TIME}ms)...`);
    const syncPromiseSingle = store1.sync();
    const receivePromiseSingle = store2.onReceive(); // Wait for the update related to singleKey

    await Promise.all([syncPromiseSingle, receivePromiseSingle]);
    log("Sync/receive for single key completed.");
    await new Promise(resolve => setTimeout(resolve, SYNC_DELAY)); // Extra propagation time

    // Check if Client 2 has the final value
    const receivedValue = await store2.get(singleKey);
    log(`Client 2 final value for "${singleKey}":`, receivedValue);

    assert.ok(receivedValue, `❌ Final value for ${singleKey} was not received`);
    assert.strictEqual(receivedValue.message, finalValue.message, "❌ Final value was not correctly synced");
    log("✅ TEST PASSED: Final value was correctly synced after rapid updates");


    // Test: Updates to the same key that cross debounce boundaries
    // This test is less deterministic due to network/relay timing.
    // We expect *at least* the final value to be present.
    log("\n--- Test: Updates crossing debounce boundaries ---");

    const crossDebounceKey = 'cross-debounce-key';
    const finalCrossValue = { message: "Final cross-debounce value", timestamp: Date.now() };

    log(`Making 3 updates to the same key with ${DEBOUNCE_TIME + 100}ms delay...`);

    // Track received values for this key
    const receivedCrossValues = [];
    const crossValueListener = store2.onChange((key, value) => {
      if (key === crossDebounceKey) {
        log(` -> Client 2 received change for key "${key}": ${JSON.stringify(value)}`);
        receivedCrossValues.push(value);
      }
    });

    // Update the same key multiple times with a delay that will cross debounce boundaries
    for (let i = 0; i < 3; i++) { // Reduced number
      const value = { message: `Cross-debounce value ${i}`, timestamp: Date.now() };
      await store1.set(crossDebounceKey, value);
      // Delay longer than debounce time
      await createSmallDelay(DEBOUNCE_TIME + 100);
      // Wait for the sync triggered by this set to likely complete
      await store1.sync();
      log(`Update ${i} sent and synced.`);
    }

    // Set the final value
    log("Setting final cross-debounce value...");
    await store1.set(crossDebounceKey, finalCrossValue);

    // Wait for sync and receive to happen for the final value
    log(`Waiting for final sync and receive...`);
    const syncPromiseCross = store1.sync();
    const receivePromiseCross = store2.onReceive(); // Wait for the final update

    await Promise.all([syncPromiseCross, receivePromiseCross]);
    log("Sync/receive for final cross-debounce value completed.");
    await new Promise(resolve => setTimeout(resolve, SYNC_DELAY)); // Extra propagation time

    // Remove the listener
    crossValueListener(); // Use the returned function to remove

    // Check if Client 2 has the final value
    const receivedCrossValue = await store2.get(crossDebounceKey);
    log(`Client 2 final value for "${crossDebounceKey}":`, receivedCrossValue);
    log(`Client 2 received ${receivedCrossValues.length} updates in total for this key`);

    assert.ok(receivedCrossValue, `❌ Final cross-debounce value for ${crossDebounceKey} was not received`);
    assert.strictEqual(receivedCrossValue.message, finalCrossValue.message, "❌ Final cross-debounce value was not correctly synced");
    // We can't reliably assert the number of intermediate updates received due to network timing.
    log("✅ TEST PASSED: Final cross-debounce value was correctly synced");


    // Clean up main listener
    removeListener();

    log("\n--- All tests completed ---");

  } catch (error) {
    console.error("Test failed with error:", error);
    // Re-throw the error to ensure non-zero exit code
    throw error;
  } finally {
    // Close connections
    await store1.close();
    await store2.close();

    log("Test completed, connections closed.");
    // No need for process.exit(0); successful completion implies exit code 0
  }
}

// Run the test
runTest();
