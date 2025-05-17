(ns nkv
  "Use Nostr relays as a remoteStorage key-value store.
  Last write wins. Eventually consistent. Offline first. There's no rush."
  (:require
    ["nostr-tools" :refer [NostrTools]]))

(def default-relays ["wss://relay.damus.io"
                     "wss://relay.nostr.band"])

(def backoff-timings
  [1000 1000 2000 3000 5000 10000 30000])

(defn pubkey [sk]
  (NostrTools.getPublicKey sk))

; schedule sync:
; - after writes
; - when we receive a kv and the remote is out of date
; - [optional] when window.online is triggered

; kv local structure
; - namespace prefixed key
; {:lm :ls :v} = {:last-modified :last-synced :value}
; Nostr's created_at has a 1 second resolution so we keep independent timestamps

; TODO fix:
; - maximum retries/recurs and/or timeout with exponential backoff

(defn received-event [nkvi event]
  (js/console.log "nkv event" (:ns nkvi) event)
  ; if received is more recent
  ;   update local item
  ; else if received is older (remote out of date) 
  ;   set local.last-synced to received.last-synced to force key re-sync
  ;   schedule a sync
  )

(defn subscribe-to-updates [nkvi]
  (.subscribeMany
    (:pool nkvi)
    (clj->js (:relays nkvi))
    (clj->js [{:kinds [(:kind nkvi)]
               "#p" [(pubkey (:sk nkvi))]
               "#d" [(str "_nkv-" (:ns nkvi))]}])
    (clj->js
      {:onevent #(received-event nkvi %)
       :oneose (fn [] (js/console.log "nkv eose"))}))
  nkvi)

(defn create-store
  "Create a new nostr key value store.
  opts:
  - ns = namespace for this store (default: nil)
  - kind = nostr kind (default: 31337)
  - sk = secret key (default: generated key bytes)
  - relays (default: [relay.damus.io, relay.nostr.band])"
  [opts]
  (subscribe-to-updates
    (merge
      {:ns nil
       :kind 31337
       :sk (or (:sk opts) (NostrTools.generateSecretKey))
       :relays default-relays
       ; internal
       :pool (NostrTools.pool.SimplePool.)
       :state (atom {:last-write 0
                     :running nil ; promise which resolves when sync has run
                     :queued false ; set to true to queue up another sync after
                     })}
      opts)))

(defn nkv-key [nkvi k]
  (let [nkv-ns (:ns nkvi)]
    (str "_nkv-"
         (when nkv-ns
           (str nkv-ns "-"))
         k)))

(defn *nkv-sync [[_res _err] _nkvi & [_iteration]]
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
  ;           post the key and value to nostr
  ;           update the key last-synced to last-modified in the localStorage
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
                        (*nkv-sync [res err] nkvi))))))))

(defn nkv-get-raw [nkvi k]
  (as-> k k
    (nkv-key nkvi k)
    (.getItem js/localStorage k)
    (js/JSON.parse k)
    (js->clj k :keywordize-keys true)))

(defn nkv-get [nkvi k]
  (:v (nkv-get-raw nkvi k)))

(defn nkv-set [nkvi k v]
  (let [current-value (nkv-get-raw nkvi k)]
    (.setItem js/localStorage
              (nkv-key nkvi k)
              (->> {:v v
                    ; last-modified
                    :lm (-> (js/Date) .getTime)}
                   (merge current-value) ; keep last-sync'ed
                   clj->js
                   js/JSON.stringify)))
  (nkv-sync nkvi))

(defn nkv-del [nkvi k]
  (nkv-set nkvi k nil))
