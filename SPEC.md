- Browser library.
- A key-value store that writes to IndexedDb in the browser and those values are persisted to Nostr type 30078 "app data".
- Sync happens via nostr so multiple clients can use the same sync'ed kv.
- Collision handling is simply done on last-modified value of the keys (last write wins).
- Each writer/device/user has a key for publishing (auth_nsec), and there is a shared key for encrypting the content and addressing it (kv_nsec).
- Wraps the `idb-keyval` library.
- Uses the `nostr-tools` library.
- kv store is always namespaced.
- `set()` adds `last-modified` metadata.
- Pushes the updated keys to the nostr datastore with a 'replace' tag:

```
let eventTemplate = {
  kind: 30078,
  created_at: Math.floor(Date.now() / 1000),
  tags: [["d", ns], ["a", "30078:" + auth_pubkey + ":" + ns], ["p", box_pubkey]],
  content: 'hello world ' + Math.random(),
}
```

The "a" tag will ensure this writer's old keyv data is replaced.

- Clients filter/listen for updates from other clients with the "p#" filter on the box_pubkey.
  `relay.subscribe([{"#p":["<box-pubkey>"],"kinds":[30078]}])`
- The actual content can be encrypted over kv_nsec so that only clients with the shared key can read it.
- Unit / e2e testing can be done with a locally running nostr relay.
- Functional code not OO.
