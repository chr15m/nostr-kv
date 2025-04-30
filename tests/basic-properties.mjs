// Import common test utilities
import { setupTestEnvironment, logTestStart } from './common.mjs';

// Import necessary tools
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import * as nip19 from 'nostr-tools/nip19';
import { createStore } from '../index.js';
import assert from 'node:assert/strict'; // Import assert

// Test configuration
const TEST_NAMESPACE = 'properties-test-' + Math.floor(Math.random() * 1000000);

// Setup test environment
const { relayURLs } = setupTestEnvironment();

async function runTest() {
  logTestStart(import.meta.url); // Log the start of the test
  console.log(`Starting basic properties test with namespace: ${TEST_NAMESPACE}`);

  // Generate a shared encryption key (kvNsec)
  const kvSecretKey = generateSecretKey();
  const kvNsec = nip19.nsecEncode(kvSecretKey);
  const kvPubkey = getPublicKey(kvSecretKey);

  console.log(`Using shared kvPubkey: ${kvPubkey}`);

  // Create a store with the test relays
  const store = createStore({
    namespace: TEST_NAMESPACE,
    kvNsec: kvNsec,
    relays: relayURLs,
    dbName: `test-${TEST_NAMESPACE}`,
  });

  // Check that the store has the expected methods
  console.log("\n--- Testing store interface ---");

  const expectedMethods = [
    'get', 'set', 'del', 'onChange', 'sync', 'close', 'keys', 'onReceive'
  ];

  let allMethodsPresent = true;
  for (const method of expectedMethods) {
    if (typeof store[method] === 'function') {
      console.log(`✅ Store has method: ${method}`);
    } else {
      console.log(`❌ Missing method: ${method}`);
      allMethodsPresent = false;
    }
  }

  assert.ok(allMethodsPresent, "❌ Store is missing some expected methods");
  console.log("✅ Store has all expected methods");


  // Check keys method
  console.log("\n--- Testing keys method ---");

  const keys = store.keys();
  assert.ok(keys && keys.auth && keys.kv, "❌ store.keys() doesn't have the expected structure");
  console.log("✅ store.keys() contains both auth and kv keys");
  console.log(`auth.npub: ${keys.auth.npub}`);
  console.log(`kv.npub: ${keys.kv.npub}`);

  // Verify that kvPubkey matches what we expect
  const decodedKvPubkey = nip19.decode(keys.kv.npub).data;
  assert.strictEqual(decodedKvPubkey, kvPubkey, "❌ kv.npub doesn't match the one we provided");
  console.log("✅ kv.npub matches the one we provided");

  // Verify that kvSecretKey matches what we expect
  assert.strictEqual(keys.kv.nsec, kvNsec, "❌ kv.nsec doesn't match the one we provided");
  console.log("✅ kv.nsec matches the one we provided");


  // Test that sync() resolves immediately when there's no pending sync
  console.log("\n--- Testing sync() with no pending sync ---");
  const startTime = Date.now();
  const syncStatus = await store.sync(); // Check status
  const endTime = Date.now();
  const elapsed = endTime - startTime;

  console.log(`sync() resolved in ${elapsed}ms with status: ${syncStatus}`);
  assert.ok(elapsed < 100, "❌ sync() took too long to resolve when no sync was pending");
  assert.strictEqual(syncStatus, true, "❌ sync() should resolve true when no sync is pending");
  console.log("✅ sync() resolved immediately and returned true when no sync was pending");


  // Test basic storage functionality
  console.log("\n--- Testing basic storage ---");
  const testKey = 'test-key';
  const testValue = { message: 'Hello, world!', timestamp: Date.now() };

  await store.set(testKey, testValue);
  console.log(`Set value for key "${testKey}":`, testValue);

  // wait for the store to sync
  await store.sync();

  const retrievedValue = await store.get(testKey);
  console.log(`Retrieved value for key "${testKey}":`, retrievedValue);

  assert.deepStrictEqual(retrievedValue, testValue, "❌ Retrieved value doesn't match set value");
  console.log("✅ Retrieved value matches set value");


  // Test onChange with callback
  console.log("\n--- Testing onChange with callback ---");

  // Create a store with the test relays
  const store2 = createStore({
    namespace: TEST_NAMESPACE,
    kvNsec: kvNsec,
    relays: relayURLs,
    dbName: `test2-${TEST_NAMESPACE}`,
  });

  let callbackResolve = null;
  let changeDetected = false;
  let detectedValue = null; // Store detected value for assertion

  // Create a promise that will be resolved when the callback is triggered
  let callbackPromise = new Promise(resolve => {
    callbackResolve = resolve;
  });

  // Make a change that should trigger the callback
  const changeKey = 'callback-test-key';
  const changeValue = { message: 'This should trigger the callback', timestamp: Date.now() };

  // Register a change listener that will also resolve our promise
  const removeListener = store2.onChange((key, value) => {
    console.log(`Change detected: key=${key}, value=`, value);
    // ignore other changes unrelated to the key we're looking for
    if (key == changeKey) {
      changeDetected = true;
      detectedValue = value; // Store the value
      callbackResolve({ key, value });
    }
  });


  console.log(`Setting value for key "${changeKey}" to trigger callback`);
  await store.set(changeKey, changeValue);

  // Wait for the store to sync
  await store.sync();

  // wait for the callback to fire
  const result = await callbackPromise;

  assert.ok(changeDetected, "❌ onChange callback was not triggered");
  console.log("✅ onChange callback was triggered");

  assert.strictEqual(result.key, changeKey, `❌ Detected key "${result.key}" doesn't match the key we changed "${changeKey}"`);
  console.log("✅ Detected key matches the key we changed");

  assert.deepStrictEqual(result.value, changeValue, "❌ Detected value doesn't match the value we set");
  console.log("✅ Detected value matches the value we set");


  // Test removing the listener
  console.log("\n--- Testing listener removal ---");
  removeListener();
  console.log("Listener removed");

  // Make another change that should not trigger the callback
  const anotherKey = 'another-test-key';
  const anotherValue = { message: 'This should not trigger the callback', timestamp: Date.now() };
  changeDetected = false; // Reset flag

  console.log(`Setting value for key "${anotherKey}" after removing listener`);
  await store.set(anotherKey, anotherValue);

  // Wait for the store to sync
  await store.sync();

  // Give a little time to ensure callback isn't triggered
  await new Promise(resolve => setTimeout(resolve, 1000));

  assert.ok(!changeDetected, "❌ Callback was triggered even after removal");
  console.log("✅ Callback was not triggered after removal");


  // Clean up
  console.log("\n--- Cleaning up ---");
  await store.close();
  await store2.close(); // Close store2 as well
  console.log("\nTest completed, connections closed.");
}

// Run the test
runTest().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
