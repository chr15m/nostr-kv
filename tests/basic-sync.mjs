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
const TEST_NAMESPACE = 'sync-test-' + Math.floor(Math.random() * 1000000);
const TEST_RELAY = 'wss://relay.damus.io';
const SYNC_DELAY = 10000; // Maximum time to wait for sync to happen

// Remove debug code

async function runTest() {
  log(`Starting sync test with namespace: ${TEST_NAMESPACE}`);

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

  log(`Client 1 authPubkey: ${authPubkey1}`);
  log(`Client 2 authPubkey: ${authPubkey2}`);

  // Check if DEBUG environment variable is set
  const debugEnabled = process.env.DEBUG !== undefined;

  // Create two stores with the same kvNsec but different authNsec and isolated databases
  const store1 = createStore({
    namespace: TEST_NAMESPACE,
    authNsec: nip19.nsecEncode(authSecretKey1),
    kvNsec: kvNsec,
    relays: [TEST_RELAY],
    debounce: 100, // Use a small debounce for testing
    dbName: `client1-${TEST_NAMESPACE}`, // Unique database name for client 1
    debug: debugEnabled // Enable debug logging based on environment variable
  });

  const store2 = createStore({
    namespace: TEST_NAMESPACE,
    authNsec: nip19.nsecEncode(authSecretKey2),
    kvNsec: kvNsec,
    relays: [TEST_RELAY],
    debounce: 100, // Use a small debounce for testing
    dbName: `client2-${TEST_NAMESPACE}`, // Unique database name for client 2
    debug: debugEnabled // Enable debug logging based on environment variable
  });

  // Set up change listener for store2
  let syncReceived = false;
  const removeListener = store2.onChange((key, value) => {
    log(`Client 2 received change for key "${key}": ${JSON.stringify(value)}`);
    syncReceived = true;
  });

  try {
    // Test 1: Client 1 writes, Client 2 should receive
    log("\n--- Test 1: Client 1 writes, Client 2 receives ---");

    // Client 1 sets a value
    const testKey = 'test-key-' + Date.now();
    const testValue = { message: 'Hello from Client 1', timestamp: Date.now() };

    log(`Client 1 setting "${testKey}" to:`, testValue);
    await store1.set(testKey, testValue);

    // Wait for sync to happen
    log(`Waiting for sync...`);
    await store1.sync();
    
    // Give some time for the relay to propagate the event to client 2
    log(`Waiting for relay propagation (max ${SYNC_DELAY}ms)...`);
    await new Promise(resolve => setTimeout(resolve, SYNC_DELAY));

    // Client 2 should have received the change via the onChange handler
    // Now verify by reading directly
    const receivedValue = await store2.get(testKey);
    log(`Client 2 reading "${testKey}":`, receivedValue);

    if (receivedValue && receivedValue.message === testValue.message) {
      log("✅ Test 1 PASSED: Client 2 successfully received data from Client 1");
    } else {
      log("❌ Test 1 FAILED: Client 2 did not receive the correct data");
    }

    // Test 2: Client 2 writes, Client 1 should receive
    log("\n--- Test 2: Client 2 writes, Client 1 receives ---");

    // Reset sync flag
    syncReceived = false;

    // Set up change listener for store1
    let client1SyncReceived = false;
    const removeListener1 = store1.onChange((key, value) => {
      log(`Client 1 received change for key "${key}": ${JSON.stringify(value)}`);
      client1SyncReceived = true;
    });

    // Client 2 sets a value
    const testKey2 = 'test-key-2-' + Date.now();
    const testValue2 = { message: 'Hello from Client 2', timestamp: Date.now() };

    log(`Client 2 setting "${testKey2}" to:`, testValue2);
    await store2.set(testKey2, testValue2);

    // Wait for sync to happen
    log(`Waiting for sync...`);
    await store2.sync();
    
    // Give some time for the relay to propagate the event to client 1
    log(`Waiting for relay propagation (max ${SYNC_DELAY}ms)...`);
    await new Promise(resolve => setTimeout(resolve, SYNC_DELAY));

    // Client 1 should have received the change
    const receivedValue2 = await store1.get(testKey2);
    log(`Client 1 reading "${testKey2}":`, receivedValue2);

    if (receivedValue2 && receivedValue2.message === testValue2.message) {
      log("✅ Test 2 PASSED: Client 1 successfully received data from Client 2");
    } else {
      log("❌ Test 2 FAILED: Client 1 did not receive the correct data");
    }

    // Test 3: Last-write-wins conflict resolution (using internal timestamps)
    log("\n--- Test 3: Last-write-wins conflict resolution ---");

    const conflictKey = 'conflict-key';
    const value1 = { message: 'Value from Client 1' };
    const value2 = { message: 'Value from Client 2' };

    // Client 1 sets the value first
    log(`Client 1 setting "${conflictKey}" to:`, value1);
    await store1.set(conflictKey, value1);

    // Wait a moment to ensure timestamps are different
    await new Promise(resolve => setTimeout(resolve, 100));

    // Client 2 sets a different value (later timestamp is handled internally)
    log(`Client 2 setting "${conflictKey}" to:`, value2);
    await store2.set(conflictKey, value2);

    // Wait for client1 to publish its changes
    log(`Waiting for client1 to publish...`);
    await store1.sync();

    // Wait for client2 to publish its changes
    log(`Waiting for client2 to publish...`);
    await store2.sync();
    
    // Give some time for the relay to propagate the events between clients
    log(`Waiting for relay propagation (max ${SYNC_DELAY}ms)...`);
    await new Promise(resolve => setTimeout(resolve, SYNC_DELAY));

    // Wait for client1 to receive client2's changes
    log(`Waiting for client1 to receive client2's changes (max ${SYNC_DELAY}ms)...`);
    await new Promise((resolve) => {
      // If we already received the change, resolve immediately
      store1.get(conflictKey).then(value => {
        if (value && value.message === value2.message) {
          resolve();
          return;
        }

        const timeout = setTimeout(resolve, SYNC_DELAY);
        const unsubscribe = store1.onChange((key, value) => {
          if (key === conflictKey && value && value.message === value2.message) {
            clearTimeout(timeout);
            unsubscribe();
            resolve();
          }
        });
      });
    });

    // Wait for client2 to receive client1's changes (though client2's should win)
    log(`Waiting for client2 to receive client1's changes (max ${SYNC_DELAY}ms)...`);
    await new Promise((resolve) => {
      // If we already have the right value, resolve immediately
      store2.get(conflictKey).then(value => {
        if (value && value.message === value2.message) {
          resolve();
          return;
        }

        const timeout = setTimeout(resolve, SYNC_DELAY);
        const unsubscribe = store2.onChange((key) => {
          if (key === conflictKey) {
            clearTimeout(timeout);
            unsubscribe();
            resolve();
          }
        });
      });
    });

    // Both clients should have the later value
    const client1Final = await store1.get(conflictKey);
    const client2Final = await store2.get(conflictKey);

    log(`Client 1 final value for "${conflictKey}":`, client1Final);
    log(`Client 2 final value for "${conflictKey}":`, client2Final);

    if (client1Final && client1Final.message === value2.message &&
        client2Final && client2Final.message === value2.message) {
      log("✅ Test 3 PASSED: Both clients have the latest value");
    } else {
      log("❌ Test 3 FAILED: Clients have different values or incorrect value");
    }

    // Clean up
    removeListener();
    removeListener1();

    log("\n--- All tests completed ---");

  } catch (error) {
    log("Test failed with error:", error);
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

function log() {
  console.log.apply(null, [new Date()].concat(Array.from(arguments)));
}
