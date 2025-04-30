// Import common test utilities
import { setupTestEnvironment, logTestStart } from './common.mjs';

// Import necessary tools
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import * as nip19 from 'nostr-tools/nip19';
import { createStore } from '../index.js';
import assert from 'node:assert/strict'; // Import assert

// Test configuration
const TEST_NAMESPACE = 'sync-test-' + Math.floor(Math.random() * 1000000);

const log = console.log.bind(console);

// Setup test environment
const { relayURLs } = setupTestEnvironment();

async function runTest() {
  logTestStart(import.meta.url); // Log the start of the test
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

  // Create two stores with the same kvNsec but different authNsec and isolated databases
  const store1 = createStore({
    namespace: TEST_NAMESPACE,
    authNsec: nip19.nsecEncode(authSecretKey1),
    kvNsec: kvNsec,
    relays: relayURLs,
    dbName: `client1-${TEST_NAMESPACE}`, // Unique database name for client 1
  });

  const store2 = createStore({
    namespace: TEST_NAMESPACE,
    authNsec: nip19.nsecEncode(authSecretKey2),
    kvNsec: kvNsec,
    relays: relayURLs,
    dbName: `client2-${TEST_NAMESPACE}`, // Unique database name for client 2
  });

  // We'll use the promise-based onChange for waiting for changes

  // Test 1: Client 1 writes, Client 2 should receive
  log("\n--- Test 1: Client 1 writes, Client 2 receives ---");

  // Client 1 sets a value
  const testKey = 'test-key-' + Date.now();
  const testValue = { message: 'Hello from Client 1 ' + authPubkey1.slice(0,8), timestamp: Date.now() };

  log(`Client 1 setting "${testKey}" to:`, testValue);
  await store1.set(testKey, testValue);

  // Wait for both client1 to sync AND client2 to receive the change
  log(`Waiting for client1 to sync and client2 to receive the change...`);
  const [_sync1, change] = await Promise.all([
    store1.sync(),
    store2.onChange()
  ]);

  log(`Client 2 received change for key "${change.key}": ${JSON.stringify(change.value)}`);

  // Verify the change is what we expect
  assert.strictEqual(change.key, testKey, `❌ Test 1 FAILED: Unexpected key received: ${change.key}, expected: ${testKey}`);

  // Client 2 should have received the change via the onChange handler
  // Now verify by reading directly
  const receivedValue = await store2.get(testKey);
  log(`Client 2 reading "${testKey}":`, receivedValue);

  // Assert that receivedValue exists and its message matches
  assert.ok(receivedValue, `❌ Test 1 FAILED: Client 2 did not receive any data for key "${testKey}"`);
  assert.strictEqual(receivedValue.message, testValue.message, `❌ Test 1 FAILED: Client 2 received incorrect message.`);

  // If the assertions pass, log success
  log(`\n✅ Test 1 PASSED: Client 2 successfully received data from Client 1`);
  log(`   Expected: ${testValue.message}`);
  log(`   Received: ${receivedValue.message}`);


  // Test 2: Client 2 writes, Client 1 should receive
  log("\n--- Test 2: Client 2 writes, Client 1 receives ---");

  // We'll use the promise-based onChange for client1 too

  // Client 2 sets a value
  const testKey2 = 'test-key-2-' + Date.now();
  const testValue2 = { message: 'Hello from Client 2 ' + authPubkey2.slice(0,8), timestamp: Date.now() };

  log(`Client 2 setting "${testKey2}" to:`, testValue2);
  await store2.set(testKey2, testValue2);

  // Wait for both client2 to sync AND client1 to receive the change
  log(`Waiting for client2 to sync and client1 to receive the change...`);
  const [_sync2, change2] = await Promise.all([
    store2.sync(),
    store1.onChange()
  ]);

  log(`Client 1 received change for key "${change2.key}": ${JSON.stringify(change2.value)}`);

  // Verify the change is what we expect
  assert.strictEqual(change2.key, testKey2, `❌ Test 2 FAILED: Unexpected key received: ${change2.key}, expected: ${testKey2}`);

  // Client 1 should have received the change
  const receivedValue2 = await store1.get(testKey2);
  log(`Client 1 reading "${testKey2}":`, receivedValue2);

  // Assert that receivedValue2 exists and its message matches
  assert.ok(receivedValue2, `❌ Test 2 FAILED: Client 1 did not receive any data for key "${testKey2}"`);
  assert.strictEqual(receivedValue2.message, testValue2.message, `❌ Test 2 FAILED: Client 1 received incorrect message.`);

  // If the assertions pass, log success
  log(`\n✅ Test 2 PASSED: Client 1 successfully received data from Client 2`);
  log(`   Expected: ${testValue2.message}`);
  log(`   Received: ${receivedValue2.message}`);


  // Test 3: Last-write-wins conflict resolution (using internal timestamps)
  log("\n--- Test 3: Last-write-wins conflict resolution ---");

  const conflictKey = 'conflict-key';
  const value1 = { message: 'Value from Client 1 ' + authPubkey1.slice(0,8) };
  const value2 = { message: 'Value from Client 2 ' + authPubkey2.slice(0,8) };

  const receivePromises = [
    store1.onReceive(),
    store2.onReceive(),
  ];

  // Client 1 sets the value first
  log(`Client 1 setting "${conflictKey}" to:`, value1);
  await store1.set(conflictKey, value1);

  // Wait a moment to ensure timestamps are different
  await new Promise(resolve => setTimeout(resolve, 100));

  // Client 2 sets a different value (later timestamp is handled internally)
  log(`Client 2 setting "${conflictKey}" to:`, value2);
  await store2.set(conflictKey, value2);

  // Wait for changes to propagate between clients
  log(`Waiting for changes to propagate between clients...`);

  // Create promises for both syncs and both clients receiving changes
  const syncPromises = [
    store1.sync(),
    store2.sync(),
  ];

  // Wait for all syncs and receives to complete
  await Promise.all([...syncPromises, ...receivePromises], { depth: null });

  log(`Both clients have received updates for the conflict key`);

  // Both clients should have the later value
  const client1Final = await store1.get(conflictKey);
  const client2Final = await store2.get(conflictKey);

  log(`Client 1 final value for "${conflictKey}":`, client1Final);
  log(`Client 2 final value for "${conflictKey}":`, client2Final);

  // Assert both clients have the correct final value
  assert.ok(client1Final, `❌ Test 3 FAILED: Client 1 has no value for "${conflictKey}"`);
  assert.strictEqual(client1Final.message, value2.message, `❌ Test 3 FAILED: Client 1 has incorrect value.`);
  assert.ok(client2Final, `❌ Test 3 FAILED: Client 2 has no value for "${conflictKey}"`);
  assert.strictEqual(client2Final.message, value2.message, `❌ Test 3 FAILED: Client 2 has incorrect value.`);

  // If assertions pass, log success
  log("\n✅ Test 3 PASSED: Both clients have the latest value");
  log(`   Expected (both clients): ${value2.message}`);
  log(`   Client 1 received: ${client1Final.message}`);
  log(`   Client 2 received: ${client2Final.message}`);


  // No listeners to clean up with the promise-based approach

  log("\n--- All tests completed ---");


  // Close connections
  await store1.close();
  await store2.close();

  log("Test completed, connections closed.");

  // Give time for any final log messages to be printed
  // No need for process.exit(0); successful completion implies exit code 0
}

// Run the test
runTest();
