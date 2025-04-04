// Import fake-indexeddb polyfill first
import 'fake-indexeddb/auto';

// Import WebSocket implementation for Node.js environment
import { useWebSocketImplementation } from 'nostr-tools/relay';
import WebSocket from 'ws';
useWebSocketImplementation(WebSocket);

// Import necessary tools
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import * as nip19 from 'nostr-tools/nip19';
import { createStore } from './index.js';

// Test configuration
const TEST_NAMESPACE = 'offline-test-' + Math.floor(Math.random() * 1000000);
const TEST_RELAY = 'wss://relay.damus.io';
const SYNC_DELAY = 2000; // Time to wait for sync to happen

async function runTest() {
  console.log(`Starting offline test with namespace: ${TEST_NAMESPACE}`);
  
  // Generate a shared encryption key (kvNsec)
  const kvSecretKey = generateSecretKey();
  const kvNsec = nip19.nsecEncode(kvSecretKey);
  const kvPubkey = getPublicKey(kvSecretKey);
  
  console.log(`Using shared kvPubkey: ${kvPubkey}`);
  
  // Create three different auth keys (one for each client)
  const authSecretKey1 = generateSecretKey();
  const authSecretKey2 = generateSecretKey();
  const authSecretKey3 = generateSecretKey();
  
  const authPubkey1 = getPublicKey(authSecretKey1);
  const authPubkey2 = getPublicKey(authSecretKey2);
  const authPubkey3 = getPublicKey(authSecretKey3);
  
  console.log(`Client 1 authPubkey: ${authPubkey1}`);
  console.log(`Client 2 authPubkey: ${authPubkey2}`);
  console.log(`Client 3 authPubkey: ${authPubkey3} (will be offline)`);
  
  // Check if DEBUG environment variable is set
  const debugEnabled = process.env.DEBUG !== undefined;
  
  // Create three stores with the same kvNsec but different authNsec and isolated databases
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
  
  // We'll create store3 later to simulate it being offline initially
  
  try {
    // Test: Client 3 is offline while Client 1 and Client 2 make changes
    console.log("\n--- Test: Client is offline for multiple updates ---");
    
    // Client 1 sets a value
    const key1 = 'key1-' + Date.now();
    const value1 = { message: 'Update 1 from Client 1' };
    
    console.log(`Client 1 setting "${key1}" to:`, value1);
    await store1.set(key1, value1);
    
    // Wait a moment
    await new Promise(resolve => setTimeout(resolve, 500));
    
    // Client 2 sets a value
    const key2 = 'key2-' + Date.now();
    const value2 = { message: 'Update 2 from Client 2' };
    
    console.log(`Client 2 setting "${key2}" to:`, value2);
    await store2.set(key2, value2);
    
    // Wait a moment
    await new Promise(resolve => setTimeout(resolve, 500));
    
    // Client 1 updates a value
    const key3 = 'key3-' + Date.now();
    const value3 = { message: 'Update 3 from Client 1' };
    
    console.log(`Client 1 setting "${key3}" to:`, value3);
    await store1.set(key3, value3);
    
    // Wait for sync between Client 1 and Client 2
    console.log(`Waiting ${SYNC_DELAY}ms for sync between online clients...`);
    await new Promise(resolve => setTimeout(resolve, SYNC_DELAY));
    
    // Verify Client 1 and Client 2 are in sync
    const client1Key1 = await store1.get(key1);
    const client1Key2 = await store1.get(key2);
    const client1Key3 = await store1.get(key3);
    
    const client2Key1 = await store2.get(key1);
    const client2Key2 = await store2.get(key2);
    const client2Key3 = await store2.get(key3);
    
    console.log("Client 1 values:", { key1: client1Key1, key2: client1Key2, key3: client1Key3 });
    console.log("Client 2 values:", { key1: client2Key1, key2: client2Key2, key3: client2Key3 });
    
    if (client1Key1 && client1Key2 && client1Key3 && 
        client2Key1 && client2Key2 && client2Key3) {
      console.log("✅ Online clients are in sync with each other");
    } else {
      console.log("❌ Online clients failed to sync");
    }
    
    // Now bring Client 3 online
    console.log("\n--- Bringing offline client online ---");
    
    // Create store3 now - it missed all previous updates while "offline"
    const store3 = createStore({
      namespace: TEST_NAMESPACE,
      authNsec: nip19.nsecEncode(authSecretKey3),
      kvNsec: kvNsec,
      relays: [TEST_RELAY],
      debounce: 100,
      dbName: `client3-${TEST_NAMESPACE}`, // Unique database name for client 3
      debug: debugEnabled // Enable debug logging based on environment variable
    });
    
    // Set up change listener for store3
    let changeCount = 0;
    const removeListener = store3.onChange((key, value) => {
      console.log(`Client 3 received change for key "${key}": ${JSON.stringify(value)}`);
      changeCount++;
    });
    
    // Wait for Client 3 to sync and catch up
    console.log(`Waiting for offline client to catch up (max ${SYNC_DELAY * 2}ms)...`);
    await new Promise((resolve) => {
      const timeout = setTimeout(resolve, SYNC_DELAY * 2);
      const unsubscribe = store3.onSync(() => {
        clearTimeout(timeout);
        unsubscribe();
        resolve();
      });
    });
    
    // Verify Client 3 caught up with all changes
    const client3Key1 = await store3.get(key1);
    const client3Key2 = await store3.get(key2);
    const client3Key3 = await store3.get(key3);
    
    console.log("Client 3 values after coming online:", { 
      key1: client3Key1, 
      key2: client3Key2, 
      key3: client3Key3 
    });
    console.log(`Client 3 received ${changeCount} change notifications`);
    
    if (client3Key1 && client3Key2 && client3Key3) {
      console.log("✅ TEST PASSED: Offline client successfully caught up with all changes");
    } else {
      console.log("❌ TEST FAILED: Offline client did not receive all changes");
    }
    
    // Clean up
    removeListener();
    
    console.log("\n--- Test completed ---");
    
  } catch (error) {
    console.error("Test failed with error:", error);
  } finally {
    // Close connections
    await store1.close();
    await store2.close();
    
    console.log("Test completed, connections closed.");
    // Exit immediately to prevent any further traffic
    process.exit(0);
  }
}

// Run the test
runTest().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
