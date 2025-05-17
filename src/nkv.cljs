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
    #js {:kind 0
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
    (try
      (.getItem js/localStorage k)
      (catch :default _e nil))
    (js/JSON.parse k)
    (or k #js {})))

(defn nkv-set-raw [nkvi k v & [remote-last-modified]]
  (let [current-value (nkv-get-raw nkvi k)]
    (aset current-value "v" v)
    (aset current-value "lm"
         (or remote-last-modified
             (-> (js/Date) .getTime)))
    (when remote-last-modified
      (aset current-value "ls" remote-last-modified))
    (->> current-value
        js/JSON.stringify
        (.setItem js/localStorage
                  (nkv-key nkvi k)))))

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
                  (aset "k" k)
                  (js-delete "ls"))
        encrypted-content (encrypt-content (:sk nkvi) content)
        event-template
        (clj->js
          {:kind (:kind nkvi)
           ; NOTE: this can mean remote kv gets blatted even if it's newer
           ; however it will eventually reconcile as they'll receive this
           ; event with an older last-modified and re-write their value
           ; with an updated created_at - eventually consistent.
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
  ;       nkv-get-raw the current value, last-sync, last-modified from localStorage key
  ;       if last-modified > last-synced
  ;         try
  ;           post this key and value to nostr = (:k :v :lm) but not :ls
  ;           nkv-set-last-sync the last-synced to the published last-modified
  ;           return :succeeded
  ;         catch
  ;           return :failed
  ;   if any writes failed (partial sync)
  ;     if iteration < dec(count(backoff-timings))
  ;       setTimeout
  ;          recur
  ;          ms = 1 + backoff-timing[iteration || 0]
  ;     else
  ;        set :running and :queued to nil
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
  (js/console.log "received-event" (:ns nkvi) event)
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
      (do
        (nkv-set-raw nkvi k remote-value remote-last-modified)
        ; run callback with update
        (when (fn? (:onChange nkvi))
          ((:onChange nkvi) k remote-value)))
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
               :authors [(pubkey (:sk nkvi))]
               "#nsh" [(nostr-hash nkvi (str "_nkv-" (:ns nkvi)))]}])
    (clj->js
      {:onevent #(received-event nkvi %)
       :oneose (fn [] (js/console.log "nkv eose"))}))
  nkvi)

; public API

(defn create-store
  "Create a new Nostr-synced key-value store.
  opts:
  - ns = namespace for this store (default: null)
  - sk = secret key (default: generated key bytes)
  - onChange = callback `(k, v)=>` called when a remote updates a key
  - kind = nostr kind (default: 31337)
  - relays (default: [relay.damus.io, relay.nostr.band])"
  ; TODO: let the user pass in storage and get/set/list calls
  [opts]
  (subscribe-to-updates
    (merge
      {:ns nil
       :sk (or (:sk opts)
               (NostrTools.generateSecretKey))
       :onChange nil
       :kind 31337
       :relays default-relays
       ; internal
       :pool (NostrTools.pool.SimplePool.)
       :state (atom {:last-write 0
                     :running nil ; promise which resolves when sync has run
                     :queued false ; set to true to queue up another sync after
                     })}
      opts)))

(defn wait-for-sync
  "Returns a promise that resolves once sync is done (or immediately)."
  [nkvi]
  (or
    (:running @(:state nkvi))
    (js/Promise.resolved true)))

(defn nkv-get
  "Returns the JSON blob stored under `k`."
  [nkvi k]
  (aget (nkv-get-raw nkvi k) "v"))

(defn nkv-set
  "Set the value of `k` to `v` and then start a sync to the network."
  [nkvi k v]
  (nkv-set-raw nkvi k v)
  (nkv-sync nkvi)
  nkvi)

(defn nkv-del
  "Set the value of `k` to null."
  [nkvi k]
  (nkv-set nkvi k nil))
