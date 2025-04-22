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
const TEST_NAMESPACE = 'properties-test-' + Math.floor(Math.random() * 1000000);

async function runTest() {
  console.log(`Starting basic properties test with namespace: ${TEST_NAMESPACE}`);

  // Generate a shared encryption key (kvNsec)
  const kvSecretKey = generateSecretKey();
  const kvNsec = nip19.nsecEncode(kvSecretKey);
  const kvPubkey = getPublicKey(kvSecretKey);

  console.log(`Using shared kvPubkey: ${kvPubkey}`);

  // Create a store with minimal configuration
  const store = createStore({
    namespace: TEST_NAMESPACE,
    kvNsec: kvNsec,
    // No relays specified - should use defaults
    dbName: `test-${TEST_NAMESPACE}`,
    debug: true
  });

  // Check that the store has the expected methods
  console.log("\n--- Testing store interface ---");
  
  const expectedMethods = [
    'get', 'set', 'del', 'onChange', 'onSync', 'close'
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
  
  // Check for keys method
  if (typeof store.keys === 'function') {
    console.log(`✅ Store has keys method`);
  } else {
    console.log(`❌ Missing keys method`);
    allMethodsPresent = false;
  }
  
  if (allMethodsPresent) {
    console.log("✅ Store has all expected methods");
  } else {
    console.log("❌ Store is missing some expected methods");
  }

  // Check keys method
  console.log("\n--- Testing keys method ---");
  
  const keys = store.keys();
  if (keys && keys.auth && keys.kv) {
    console.log("✅ store.keys() contains both auth and kv keys");
    console.log(`auth.npub: ${keys.auth.npub}`);
    console.log(`kv.npub: ${keys.kv.npub}`);
    
    // Verify that kvPubkey matches what we expect
    const decodedKvPubkey = nip19.decode(keys.kv.npub).data;
    if (decodedKvPubkey === kvPubkey) {
      console.log("✅ kv.npub matches the one we provided");
    } else {
      console.log("❌ kv.npub doesn't match the one we provided");
    }
    
    // Verify that kvSecretKey matches what we expect
    if (keys.kv.nsec === kvNsec) {
      console.log("✅ kv.nsec matches the one we provided");
    } else {
      console.log("❌ kv.nsec doesn't match the one we provided");
    }
  } else {
    console.log("❌ store.keys() doesn't have the expected structure");
  }

  // Test that sync() resolves immediately when there's no pending sync
  console.log("\n--- Testing sync() with no pending sync ---");
  const startTime = Date.now();
  await store.sync();
  const endTime = Date.now();
  const elapsed = endTime - startTime;
  
  console.log(`sync() resolved in ${elapsed}ms`);
  if (elapsed < 100) {
    console.log("✅ sync() resolved immediately when no sync was pending");
  } else {
    console.log("❌ sync() took too long to resolve when no sync was pending");
  }

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

  if (JSON.stringify(retrievedValue) === JSON.stringify(testValue)) {
    console.log("✅ Retrieved value matches set value");
  } else {
    console.log("❌ Retrieved value doesn't match set value");
  }

  // Clean up
  await store.close();
  console.log("\nTest completed, connection closed.");
}

// Run the test
runTest().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
