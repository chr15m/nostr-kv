(ns nkv
  "Use Nostr relays as a remoteStorage key-value store.
  Last write wins. Eventually consistent. Offline first. There's no rush."
  (:require
    ["nostr-tools" :refer [NostrTools]]))

; schedule sync:
; - after writes
; - when we receive a kv and the remote is out of date
; - [optional] when window.online is triggered

; kv local structure
; - namespace prefixed key ->
;   {:lm :ls :k :v} = {:last-modified :last-synced :key :value}
; Nostr's created_at has a 1 second resolution so we keep independent timestamps

(def default-relays ["wss://relay.damus.io"
                     "wss://relay.nostr.band"])

(def backoff-timings
  [1000 1000 2000 3000 5000 10000 30000])

(defn pubkey [sk]
  (NostrTools.getPublicKey sk))

(defn encrypt-content
  "Encrypt JSON `content` with Nostr secret key `sk`."
  [sk content]
  (NostrTools.nip04.encrypt sk (pubkey sk) (js/JSON.stringify content)))

(defn decrypt-content
  "Decrypt `encrypted-content` blob with Nostr secret key `sk` returning JSON."
  [sk encrypted-content]
  (try
    (let [decrypted (NostrTools.nip04.decrypt sk (pubkey sk) encrypted-content)]
      (js/JSON.parse decrypted))
    (catch :default e
      (js/console.error "Failed to decrypt content" e)
      nil)))

(defn nostr-hash [nkvi txt]
  ; hack to get cheap cross-platform hashing of the namespace
  ; without using async webcrypto or importing another dep
  (NostrTools.getEventHash
    #js {:kind NostrTools.kinds.Application + 3142
         :created_at 0
         :tags #js []
         :pubkey (pubkey (:sk nkvi))
         :content txt}))

(defn nkv-key [nkvi k]
  (let [nkv-ns (:ns nkvi)]
    (str "_nkv-"
         (when nkv-ns
           (str nkv-ns "-"))
         k)))

(defn nkv-get-raw [nkvi k]
  (as-> k k
    (nkv-key nkvi k)
    (.getItem js/localStorage k)
    (js/JSON.parse k)))

(defn nkv-set-raw [nkvi k v]
  (let [current-value (nkv-get-raw nkvi k)]
    (.setItem js/localStorage
              (nkv-key nkvi k)
              (->
                (doto current-value
                  (aset "v" v)
                  (aset "lm" (-> (js/Date) .getTime)))
                js/JSON.stringify))))

(defn nkv-set-last-sync [nkvi k last-sync]
  (let [current-value (nkv-get-raw nkvi k)]
    (.setItem js/localStorage
              (nkv-key nkvi k)
              (->
                (doto current-value
                  (aset "ls" last-sync))
                js/JSON.stringify))))

(defn create-event [nkvi k stored]
  (js/console.log "create-event" (pubkey (:sk nkvi)) k stored)
  (let [content (doto stored
                  (aset "k" k))
        encrypted-content (encrypt-content (:sk nkvi) content)
        event-template
        (clj->js
          {:kind (:kind nkvi)
           :created_at (js/Math.floor (/ (js/Date.now) 1000))
           :tags [["nsh" (nostr-hash nkvi (str "_nkv-" (:ns nkvi)))]
                  ["d" (nostr-hash nkvi (nkv-key nkvi k))]]
           :content encrypted-content})]
    (js/console.log "event-template" event-template)
    (NostrTools.finalizeEvent event-template (:sk nkvi))))

(defn *nkv-sync-critical-section [[_res _err] _nkvi & [_iteration]]
  ; if last-write was less than 1 second ago
  ;   setTimeout
  ;     recur [res err] nkvi
  ;     ms = (1001 - (now - last-write))
  ; else
  ;   map over all localstorage keys collecting result of (filter nulls) =
  ;     if key matches prefix
  ;       read the key from localstorage
  ;       if last-modified > last-synced
  ;         try
  ;           post the key and value to nostr = (:k :v :lm) but not :ls
  ;           update the key last-synced to the last-modified in the localStorage
  ;           return :succeeded
  ;         catch
  ;           return :failed
  ;   if any writes failed (partial sync)
  ;     if iteration < dec(count(backoff-timings))
  ;       setTimeout
  ;          recur
  ;          ms = 1 + backoff-timing[iteration || 0]
  ;     else
  ;        err
  ;   else
  ;     set last-write
  ;     if queued is true
  ;       recur
  ;     else
  ;       set :running and :queued to nil
  ;       resolve the :running promise
  )

(defn nkv-sync [{:keys [state] :as nkvi}]
  (swap! state
         (fn [*state]
           ; if there's a :running promise
           (if (:running *state)
             ; swap :queued to true
             (assoc *state :queued true)
             ; else
             ; swap :running to a new promise and capture the res
             (assoc *state
                    :running
                    (js/Promise.
                      (fn [res err]
                        ; only one of these should ever be running
                        (*nkv-sync-critical-section [res err] nkvi))))))))


(defn received-event [nkvi event]
  (js/console.log "nkv event" (:ns nkvi) event)
  (let [decrypted-content
        (decrypt-content
          (:sk nkvi)
          (aget event "content"))
        k (aget decrypted-content "k")
        local (nkv-get-raw nkvi k)
        local-last-modified (aget local "lm")
        remote-last-modified (aget decrypted-content "lm")
        remote-value (aget decrypted-content "v")]
    (cond
      ; if received is more recent
      (> remote-last-modified local-last-modified)
      ; update local item
      (nkv-set-raw nkvi k remote-value)
      ; else if received is older (remote out of date)
      (< remote-last-modified local-last-modified)
      ; set local.last-synced to received.last-synced to force key re-sync
      (do
        (nkv-set-last-sync nkvi k remote-last-modified)
        ; schedule a sync
        (nkv-sync nkvi)))))

(defn subscribe-to-updates [nkvi]
  (.subscribeMany
    (:pool nkvi)
    (clj->js (:relays nkvi))
    (clj->js [{:kinds [(:kind nkvi)]
               "#p" [(pubkey (:sk nkvi))]
               "#nsh" [(nostr-hash nkvi (str "_nkv-" (:ns nkvi)))]}])
    (clj->js
      {:onevent #(received-event nkvi %)
       :oneose (fn [] (js/console.log "nkv eose"))}))
  nkvi)

; public API

(defn create-store
  "Create a new nostr key value store.
  opts:
  - ns = namespace for this store (default: nil)
  - kind = nostr kind (default: 31337)
  - sk = secret key (default: generated key bytes)
  - relays (default: [relay.damus.io, relay.nostr.band])"
  ; TODO: let the user pass in storage and get/set/list calls
  [opts]
  (subscribe-to-updates
    (merge
      {:ns nil
       :kind 31337
       :sk (or (:sk opts)
               (NostrTools.generateSecretKey))
       :relays default-relays
       ; internal
       :pool (NostrTools.pool.SimplePool.)
       :state (atom {:last-write 0
                     :running nil ; promise which resolves when sync has run
                     :queued false ; set to true to queue up another sync after
                     })}
      opts)))

(defn nkv-get [nkvi k]
  (aget (nkv-get-raw nkvi k) "v"))

(defn nkv-set [nkvi k v]
  (nkv-set-raw nkvi k v)
  (nkv-sync nkvi))

(defn nkv-del [nkvi k]
  (nkv-set nkvi k nil))
