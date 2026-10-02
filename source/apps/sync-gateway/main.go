package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"embed"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/gorilla/websocket"
)

//go:embed public/*
var assets embed.FS
var buildVersion = "development"
var idPattern = regexp.MustCompile(`^[0-9a-fA-F-]{36}$`)

func validID(id string) bool           { return idPattern.MatchString(id) }
func validScope(s string) bool         { return s == "ai" || s == "zyy" }
func nonce() string                    { b := make([]byte, 16); _, _ = rand.Read(b); return hex.EncodeToString(b) }
func topicKey(scope, id string) string { return scope + ":" + id }

type Envelope struct {
	Epoch    string `json:"epoch"`
	Seq      uint64 `json:"seq"`
	Scope    string `json:"scope"`
	ThreadID string `json:"threadId"`
	Event    Event  `json:"event"`
}
type Topic struct {
	Seq         uint64
	Events      []Envelope
	Bytes       int
	Snapshot    *Snapshot
	Dirty       bool
	List        map[string]Thread
	PinnedIDs   []string
	NextCursor  *string
	Approvals   map[string]json.RawMessage
	Subscribers map[*browser]bool
}
type browser struct {
	conn *websocket.Conn
	send chan any
	once sync.Once
	done chan struct{}
}

func (b *browser) close() { b.once.Do(func() { close(b.done); _ = b.conn.Close() }) }

type agent struct {
	conn *websocket.Conn
	mu   sync.Mutex
	id   string
}

func (a *agent) send(v any) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	_ = a.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
	return a.conn.WriteJSON(v)
}

func (a *agent) sendReadRequest(ctx context.Context, request map[string]any) error {
	// Read callers may leave while an unrelated bridge write owns the socket.
	// Do not retain a canceled waiter behind that writer's ten-second deadline.
	for !a.mu.TryLock() {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(time.Millisecond):
		}
	}
	defer a.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return err
	}
	if deadline, ok := ctx.Deadline(); ok {
		request["readDeadlineMs"] = time.Until(deadline).Milliseconds()
	}
	writeDeadline := time.Now().Add(10 * time.Second)
	if deadline, ok := ctx.Deadline(); ok && deadline.Before(writeDeadline) {
		writeDeadline = deadline
	}
	_ = a.conn.SetWriteDeadline(writeDeadline)
	return a.conn.WriteJSON(request)
}

// Cancellation never waits behind a blocked bridge write. The remaining read
// budget is the fallback if this best-effort control message cannot be sent.
func (a *agent) cancelRead(id, scope, reason string) {
	if !a.mu.TryLock() {
		return
	}
	go func() {
		defer a.mu.Unlock()
		_ = a.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
		_ = a.conn.WriteJSON(map[string]any{"type": "cancel-read", "id": id, "scope": scope, "reason": reason})
	}()
}

type reply struct {
	Result       json.RawMessage `json:"result"`
	Error        string          `json:"error"`
	Status       int             `json:"status"`
	FailureStage string          `json:"failureStage,omitempty"`
}
type frame struct {
	Type         string          `json:"type"`
	ID           string          `json:"id"`
	Epoch        string          `json:"epoch"`
	Seq          uint64          `json:"seq"`
	BaseSeq      uint64          `json:"baseSeq"`
	Scope        string          `json:"scope"`
	ThreadID     string          `json:"threadId"`
	Event        Event           `json:"event"`
	Data         json.RawMessage `json:"data"`
	Result       json.RawMessage `json:"result"`
	Error        string          `json:"error"`
	Status       int             `json:"status"`
	FailureStage string          `json:"failureStage,omitempty"`
	MessageID    string          `json:"messageId"`
	ReadID       string          `json:"readId,omitempty"`
	Index        int             `json:"index"`
	Count        int             `json:"count"`
	Payload      string          `json:"payload"`
}
type assembly struct {
	parts  [][]byte
	size   int
	next   int
	at     time.Time
	readID string
	scope  string
}
type Gateway struct {
	push          *PushService
	durable       *DurableStore
	replica       *cacheReplica
	activeCache   atomic.Pointer[DurableStore]
	frameProofs   map[uint64]string
	staging       map[string]*Topic
	stagedEvents  []Envelope
	storeID       string
	history       *HistoryStore
	persistMu     sync.Mutex
	mu            sync.Mutex
	controlMu     sync.Mutex // bridge and pending replies never wait for topic persistence
	agentHandlers sync.WaitGroup
	epoch         string
	agentEpoch    string
	agentSeq      uint64
	bridge        *agent
	nativeOnline  bool
	topics        map[string]*Topic
	pending       map[string]*pendingCall
	uiEvents      map[string][]map[string]any
	refreshing    map[string]bool
	dir           string
	secret        []byte
	origin        string
	local         bool
}

func NewGateway(dir, origin string, secret []byte, local bool) *Gateway {
	g := &Gateway{epoch: nonce(), frameProofs: map[uint64]string{}, topics: map[string]*Topic{}, pending: map[string]*pendingCall{}, uiEvents: map[string][]map[string]any{}, refreshing: map[string]bool{}, dir: dir, secret: secret, origin: origin, local: local}
	g.history = &HistoryStore{dir: filepath.Join(dir, "history")}
	_ = os.MkdirAll(dir, 0700)
	idFile := filepath.Join(dir, ".cache-id")
	existing, err := os.ReadFile(idFile)
	if err == nil {
		g.storeID = strings.TrimSpace(string(existing))
	}
	if g.storeID == "" {
		g.storeID = nonce()
		_ = os.WriteFile(idFile, []byte(g.storeID), 0600)
	}
	for _, s := range readSnapshots(dir) {
		t := g.topicLocked(s.Scope, s.Snapshot.Thread.ID)
		snapshot := s.Snapshot
		t.Snapshot = &snapshot
		g.topicLocked(s.Scope, "").List[snapshot.Thread.ID] = snapshot.Thread
	}
	for _, scope := range []string{"ai", "zyy"} {
		data, err := os.ReadFile(filepath.Join(dir, "catalog-"+scope+".json"))
		if err == nil {
			var list []Thread
			if json.Unmarshal(data, &list) == nil {
				for _, thread := range list {
					if validID(thread.ID) {
						g.topicLocked(scope, "").List[thread.ID] = thread
					}
				}
			}
		}
	}
	for _, scope := range []string{"ai", "zyy"} {
		data, err := os.ReadFile(filepath.Join(dir, "pins-"+scope+".json"))
		if err == nil {
			var ids []string
			if json.Unmarshal(data, &ids) == nil {
				for _, id := range ids {
					if validID(id) {
						g.topicLocked(scope, "").PinnedIDs = append(g.topicLocked(scope, "").PinnedIDs, id)
					}
				}
			}
		}
	}

	var durableErr error
	g.durable, durableErr = openDurable(dir)
	if durableErr == nil {
		durableErr = g.initializeCache()
	}
	if durableErr != nil {
		if g.durable != nil {
			_ = g.durable.close()
		}
		g.durable, durableErr = openMemoryCache()
		if durableErr != nil {
			panic(fmt.Errorf("memory relay unavailable: %w", durableErr))
		}
		// A cache that cannot attest its cursor is rebuilt from Mac, not from
		// shadow files written before a failed old transaction.
		g.epoch, g.storeID, g.agentEpoch, g.agentSeq = nonce(), nonce(), "", 0
		g.topics, g.frameProofs = map[string]*Topic{}, map[uint64]string{}
		if err := g.initializeCache(); err != nil {
			panic(err)
		}
		log.Print(`{"event":"optional_cache","state":"memory","reason":"startup_storage_unavailable"}`)
	}
	return g
}
func (g *Gateway) topicLocked(scope, id string) *Topic {
	key := topicKey(scope, id)
	if g.staging != nil {
		if _, seen := g.staging[key]; !seen {
			g.staging[key] = g.topics[key]
			if old := g.topics[key]; old != nil {
				g.topics[key] = cloneTopic(old)
			}
		}
	}
	if t := g.topics[key]; t != nil {
		return t
	}
	t := &Topic{List: map[string]Thread{}, Approvals: map[string]json.RawMessage{}, Subscribers: map[*browser]bool{}}
	g.topics[key] = t
	return t
}
func (g *Gateway) publishLocked(scope, id string, e Event) {
	t := g.topicLocked(scope, id)
	if g.replica != nil && g.staging == nil {
		t = cloneTopic(t)
		g.topics[topicKey(scope, id)] = t
	}
	var prior *Topic
	if g.staging == nil && g.cacheStore() != nil && g.replica == nil {
		prior = cloneTopic(t)
	}
	t.Seq++
	encoded, _ := json.Marshal(e)
	var immutable Event
	_ = json.Unmarshal(encoded, &immutable)
	envelope := Envelope{Epoch: g.epoch, Seq: t.Seq, Scope: scope, ThreadID: id, Event: immutable}
	data, _ := json.Marshal(envelope)
	t.Events = append(t.Events, envelope)
	t.Bytes += len(data)
	for len(t.Events) > 512 || t.Bytes > 512<<10 {
		old, _ := json.Marshal(t.Events[0])
		t.Bytes -= len(old)
		t.Events = t.Events[1:]
	}
	if g.staging != nil {
		g.stagedEvents = append(g.stagedEvents, envelope)
		return
	}
	if g.staging == nil && g.cacheStore() != nil && g.replica == nil {
		if err := g.cacheStore().saveTopic(topicKey(scope, id), t); err != nil {
			if !cacheStorageFailure(err) || g.useMemoryCacheLocked(err) != nil || g.cacheStore().saveTopic(topicKey(scope, id), t) != nil {
				g.topics[topicKey(scope, id)] = prior
				log.Print("topic cache unavailable")
				return
			}
		}
	}
	g.deliverLocked(envelope)
}
func (g *Gateway) deliverLocked(envelope Envelope) {
	t := g.topics[topicKey(envelope.Scope, envelope.ThreadID)]
	if t == nil {
		return
	}
	for b := range t.Subscribers {
		select {
		case b.send <- envelope:
		default:
			b.close()
			delete(t.Subscribers, b)
		}
	}
}
func (g *Gateway) apply(f frame) error {
	return g.applyFromBridge(f, nil, time.Now())
}
func (g *Gateway) applyFromBridge(f frame, source *agent, queuedAt time.Time) error {
	return g.applyBatchFromBridge([]queuedPublication{{frame: f, at: queuedAt}}, source)
}
func (g *Gateway) applyBatchFromBridge(jobs []queuedPublication, source *agent) (err error) {
	if len(jobs) == 0 {
		return nil
	}
	first, last := jobs[0].frame, jobs[len(jobs)-1].frame
	metrics := &publicationMetrics{QueueMs: time.Since(jobs[0].at).Milliseconds(), BatchFrames: len(jobs), FirstSequence: first.Seq}
	started := time.Now()
	defer func() { metrics.CachePersistence = g.cachePersistence(); metrics.log(last, time.Since(started), err) }()
	g.persistMu.Lock()
	metrics.PersistLockMs = time.Since(started).Milliseconds()
	defer g.persistMu.Unlock()
	stateStarted := time.Now()
	g.mu.Lock()
	metrics.StateLockMs = time.Since(stateStarted).Milliseconds()
	defer g.mu.Unlock()
	if source != nil && !g.isCurrentBridge(source) {
		return errors.New("bridge replaced")
	}
	committed := false
	g.staging = map[string]*Topic{}
	g.stagedEvents = nil
	defer func() {
		if !committed {
			for key, old := range g.staging {
				if old == nil {
					delete(g.topics, key)
				} else {
					g.topics[key] = old
				}
			}
		}
		g.staging = nil
		g.stagedEvents = nil
	}()
	frames := make([]frame, 0, len(jobs))
	sequence := g.agentSeq
	for _, job := range jobs {
		f := job.frame
		if f.Epoch != g.agentEpoch {
			return errors.New("adapter epoch mismatch")
		}
		if f.Seq <= g.agentSeq {
			if got := g.frameProofs[f.Seq]; got != "" {
				if got != frameHash(f) {
					return errors.New("duplicate identity has different content")
				}
			} else if e := g.cacheStore().checkDuplicate(f); e != nil {
				if cacheStorageFailure(e) {
					return errors.New("adapter sequence gap: duplicate identity unavailable")
				}
				return e
			}
			continue
		}
		if f.Seq != sequence+1 {
			return errors.New("adapter sequence gap")
		}
		if e := g.stagePublication(f); e != nil {
			return e
		}
		frames = append(frames, f)
		sequence = f.Seq
	}
	if len(frames) == 0 {
		committed = true
		return nil
	}
	changed := map[string]*Topic{}
	for key := range g.staging {
		changed[key] = g.topics[key]
	}
	metrics.ProjectionMs = time.Since(stateStarted).Milliseconds() - metrics.StateLockMs
	if g.cacheStore() != nil {
		if e := g.cacheStore().commitBatch(frames, changed, metrics); e != nil {
			if !cacheStorageFailure(e) || g.useMemoryCacheLocked(e) != nil {
				return fmt.Errorf("cache commit: %w", e)
			}
			if e = g.cacheStore().commitBatch(frames, changed, metrics); e != nil {
				return fmt.Errorf("memory cache commit: %w", e)
			}
		}
	}
	g.agentSeq = sequence
	g.rememberFrameProofs(frames)
	committed = true
	for _, f := range frames {
		if f.Event.Type == "host" {
			g.controlMu.Lock()
			g.nativeOnline = f.Event.Online != nil && *f.Event.Online
			g.controlMu.Unlock()
		}
	}
	if g.push != nil && g.cachePersistence() == "disk" {
		g.push.signal()
	}
	for _, envelope := range g.stagedEvents {
		g.deliverLocked(envelope)
	}
	if g.replica != nil {
		g.replica.accepted.Store(&replicaCursor{g.agentEpoch, sequence})
		g.mirrorBatch(frames, changed)
		g.mirrorPush(frames, changed)
	}
	return nil
}

// Caller holds the topic lock and one staging/rollback set for the entire batch.
func (g *Gateway) stagePublication(f frame) error {
	if f.Event.Type == "host" {
		for key := range g.topics {
			p := strings.SplitN(key, ":", 2)
			g.publishLocked(p[0], p[1], f.Event)
		}
	} else {
		if !validScope(f.Scope) || (f.ThreadID != "" && !validID(f.ThreadID)) {
			return errors.New("invalid publication scope")
		}

		if f.Event.Type == "nativeRecord" {
			var record NativeRecord
			if json.Unmarshal(f.Data, &record) != nil || record.Scope != f.Scope || record.ThreadID != f.ThreadID {
				return errors.New("invalid native record")
			}
			g.publishLocked(f.Scope, "", Event{Type: "nativeChanged", ThreadID: f.ThreadID, CacheKey: record.Key, Revision: record.Revision, Generation: record.Generation})
		} else if f.Event.Type == "pins" {
			var value struct {
				IDs  []string `json:"ids"`
				Data []Thread `json:"data"`
			}
			if json.Unmarshal(f.Data, &value) != nil {
				return errors.New("invalid pins")
			}
			t := g.topicLocked(f.Scope, "")
			t.PinnedIDs = []string{}
			for _, id := range value.IDs {
				if validID(id) {
					t.PinnedIDs = append(t.PinnedIDs, id)
				}
			}
			for _, thread := range value.Data {
				if validID(thread.ID) {
					t.List[thread.ID] = thread
				}
			}
			if g.replica == nil {
				if err := atomicJSON(filepath.Join(g.dir, "pins-"+f.Scope+".json"), t.PinnedIDs); err != nil {
					return err
				}
			}
			g.publishLocked(f.Scope, "", Event{Type: "catalogChanged"})
		} else if f.Event.Type == "catalogComplete" {
			var full struct {
				IDs []string `json:"ids"`
			}
			if json.Unmarshal(f.Data, &full) != nil {
				return errors.New("invalid full catalog")
			}
			seen := map[string]bool{}
			for _, id := range full.IDs {
				seen[id] = true
			}
			t := g.topicLocked(f.Scope, "")
			for id := range t.List {
				if !seen[id] {
					delete(t.List, id)
				}
			}
			g.publishLocked(f.Scope, "", Event{Type: "catalogChanged"})
		} else if f.Event.Type == "historyPage" {
			var page Snapshot
			if json.Unmarshal(f.Data, &page) != nil || page.Thread.ID != f.ThreadID {
				return errors.New("invalid history page")
			}
			if err := g.optionalHistorySave(f.Scope, page, false, page.NextCursor == nil); err != nil {
				return err
			}
		} else if f.Event.Type == "catalog" || f.Event.Type == "catalogPage" {
			var v struct {
				Data       []Thread `json:"data"`
				NextCursor *string  `json:"nextCursor"`
			}
			if json.Unmarshal(f.Data, &v) != nil {
				return errors.New("invalid catalog")
			}
			t := g.topicLocked(f.Scope, "")
			t.NextCursor = v.NextCursor
			// Merge catalog pages; full sweep removes absent entries separately.
			for _, thread := range v.Data {
				if validID(thread.ID) {
					t.List[thread.ID] = thread
				}
			}
			if f.Event.Type == "catalog" {
				g.publishLocked(f.Scope, "", Event{Type: "catalogChanged"})
			}
		} else if f.ThreadID == "" {
			t := g.topicLocked(f.Scope, "")
			if f.Event.Thread != nil && validID(f.Event.Thread.ID) {
				t.List[f.Event.Thread.ID] = *f.Event.Thread
			}
			if f.Event.ThreadID != "" {
				v := t.List[f.Event.ThreadID]
				v.ID = f.Event.ThreadID
				if f.Event.Status != nil {
					v.Status = *f.Event.Status
				}
				if f.Event.Name != "" {
					v.Name = f.Event.Name
				}
				t.List[v.ID] = v
			}
			g.publishLocked(f.Scope, "", f.Event)
		} else {
			t := g.topicLocked(f.Scope, f.ThreadID)
			if f.Event.Type == "approvals" {
				// Reconcile a source snapshot after paused projection production.
				// Existing clients see the existing resolved/approval events only.
				wanted := map[string]json.RawMessage{}
				for _, raw := range f.Event.Approvals {
					var request struct {
						ID       json.RawMessage `json:"id"`
						ThreadID string          `json:"threadId"`
					}
					if json.Unmarshal(raw, &request) != nil || len(request.ID) == 0 || request.ThreadID != f.ThreadID {
						return errors.New("invalid approval snapshot")
					}
					wanted[string(request.ID)] = raw
				}
				for id := range t.Approvals {
					if _, exists := wanted[id]; !exists {
						g.publishLocked(f.Scope, f.ThreadID, Event{Type: "approvalResolved", RequestID: json.RawMessage(id)})
					}
				}
				t.Approvals = wanted
				t.Dirty = true
				for _, raw := range wanted {
					g.publishLocked(f.Scope, f.ThreadID, Event{Type: "approval", Request: raw})
				}
				return nil
			}
			if f.Event.Type == "approval" {
				var request struct {
					ID json.RawMessage `json:"id"`
				}
				if json.Unmarshal(f.Event.Request, &request) == nil && len(request.ID) > 0 {
					t.Approvals[string(request.ID)] = append(json.RawMessage{}, f.Event.Request...)
				}
			}
			if f.Event.Type == "approvalResolved" {
				delete(t.Approvals, string(f.Event.RequestID))
			}
			if t.Snapshot == nil {
				t.Snapshot = &Snapshot{Thread: Thread{ID: f.ThreadID}, Turns: []Turn{}}
			}
			event := f.Event
			if g.replica != nil {
				event = cloneSourceEvent(event)
			}
			applyEvent(t.Snapshot, event)
			if f.Event.Type == "snapshot" {
				if g.cachePersistence() == "disk" && g.replica == nil {
					if err := saveSnapshot(g.dir, f.Scope, *t.Snapshot); err != nil {
						if !cacheStorageFailure(err) {
							return err
						}
						if err = g.useMemoryCacheLocked(err); err != nil {
							return err
						}
					}
				}
				if err := g.optionalHistorySave(f.Scope, *t.Snapshot, true, t.Snapshot.NextCursor == nil); err != nil {
					return err
				}
			}
			t.Dirty = true
			g.topicLocked(f.Scope, "").List[f.ThreadID] = t.Snapshot.Thread
			g.publishLocked(f.Scope, f.ThreadID, f.Event)
			// Android subscribes to the workspace feed independently of the visible
			// conversation. Persist its text stream in this same source transaction.
			// Use the workspace cursor; retain the actual conversation in the event.
			switch f.Event.Type {
			case "snapshot", "turn", "item", "delta":
				background := f.Event
				background.ThreadID = f.ThreadID
				g.publishLocked(f.Scope, "", background)
			}
		}
	}

	return nil
}
func contextFailureClass(err error) string {
	if errors.Is(err, context.Canceled) {
		return "canceled"
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return "deadline"
	}
	return "unknown"
}
func (g *Gateway) call(ctx context.Context, scope, op string, body any) (json.RawMessage, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	id := nonce()
	if t, _ := ctx.Value(nativeReadTraceKey{}).(*nativeReadTrace); t != nil && t.bridgeID != "" {
		id = t.bridgeID
	}
	trace := nativeReadTraceFrom(ctx, id)
	trace.event("dispatch", "bridge_dispatch", nil)
	lockStarted := time.Now()
	g.controlMu.Lock()
	lockMs := time.Since(lockStarted).Milliseconds()
	a := g.bridge
	if a == nil || !g.nativeOnline {
		g.controlMu.Unlock()
		trace.event("failed", "bridge_dispatch", map[string]any{"failureClass": "connection"})
		return nil, errors.New("Mac 暂未连接")
	}
	if len(g.pending) >= 128 {
		g.controlMu.Unlock()
		trace.event("failed", "bridge_dispatch", map[string]any{"failureClass": "capacity"})
		return nil, errors.New("请求较多，请稍后重试")
	}
	channel := make(chan reply, 1)
	g.pending[id] = &pendingCall{reply: channel, trace: trace, source: a, op: op, scope: scope}
	pendingRequests := len(g.pending)
	g.controlMu.Unlock()
	defer func() { g.controlMu.Lock(); delete(g.pending, id); g.controlMu.Unlock() }()
	request := map[string]any{"type": "request", "id": id, "scope": scope, "op": op, "body": body}
	if trace != nil && diagnosticUUID.MatchString(trace.traceID) {
		request["traceId"] = trace.traceID
	}
	var sendErr error
	if op == "native-read" {
		sendErr = a.sendReadRequest(ctx, request)
	} else {
		sendErr = a.send(request)
	}
	if err := sendErr; err != nil {
		failureClass := "connection"
		if ctx.Err() != nil {
			failureClass = contextFailureClass(ctx.Err())
		}
		trace.event("failed", "bridge_dispatch", map[string]any{"failureClass": failureClass})
		return nil, errors.New("连接中断；发送结果需核对")
	}
	trace.event("pending", "bridge_reply", map[string]any{"pendingRequests": pendingRequests, "controlLockMs": lockMs})
	select {
	case value := <-channel:
		if value.Error != "" {
			trace.event("failed", "bridge_reply", map[string]any{"failureClass": "adapter", "failureStage": safeReadFailureStage(value.FailureStage), "statusCode": value.Status})
			return nil, errors.New(value.Error)
		}
		trace.event("received", "bridge_reply", nil)
		return value.Result, nil
	case <-ctx.Done():
		trace.event("failed", "bridge_reply", map[string]any{"failureClass": contextFailureClass(ctx.Err())})
		if op == "native-read" {
			a.cancelRead(id, scope, contextFailureClass(ctx.Err()))
		}
		return nil, errors.New("确认尚未收到，请核对请求状态")
	}
}
func (g *Gateway) refresh(scope, id string) {
	key := topicKey(scope, id)
	g.mu.Lock()
	if g.refreshing[key] || !g.hasBridge() {
		g.mu.Unlock()
		return
	}
	g.refreshing[key] = true
	g.mu.Unlock()
	go func() {
		defer func() { g.mu.Lock(); delete(g.refreshing, key); g.mu.Unlock() }()
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		op := "watch"
		if id == "" {
			op = "catalog"
		}
		_, _ = g.call(ctx, scope, op, map[string]any{"threadId": id})
	}()
}
func (g *Gateway) flush() {
	if g.replica != nil {
		return
	}
	if g.cachePersistence() == "memory" {
		return
	}
	g.persistMu.Lock()
	defer g.persistMu.Unlock()
	g.mu.Lock()
	values := []Stored{}
	for key, t := range g.topics {
		if !t.Dirty || t.Snapshot == nil {
			continue
		}
		data, _ := json.Marshal(t.Snapshot)
		var snapshot Snapshot
		_ = json.Unmarshal(data, &snapshot)
		values = append(values, Stored{Scope: strings.SplitN(key, ":", 2)[0], Snapshot: snapshot})
		t.Dirty = false
	}
	catalogs := map[string][]Thread{}
	for _, scope := range []string{"ai", "zyy"} {
		for _, thread := range g.topicLocked(scope, "").List {
			catalogs[scope] = append(catalogs[scope], thread)
		}
	}
	g.mu.Unlock()
	for scope, list := range catalogs {
		_ = atomicJSON(filepath.Join(g.dir, "catalog-"+scope+".json"), list)
	}
	for _, v := range values {
		_ = saveSnapshot(g.dir, v.Scope, v.Snapshot)
		_ = g.history.save(v.Scope, v.Snapshot, true, v.Snapshot.NextCursor == nil)
	}
	pruneStore(g.dir, 64<<20)
}
func (g *Gateway) serveAgent(w http.ResponseWriter, r *http.Request) {
	diagnosticID, started := r.Header.Get("X-DSH-Diagnostic-ID"), time.Now()
	token := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	if len(token) != len(g.secret) || subtle.ConstantTimeCompare([]byte(token), g.secret) != 1 {
		logConnection("cloud-bridge", "rejected", diagnosticID, "", "authentication", nil, started)
		http.Error(w, "unauthorized", 401)
		return
	}
	if r.Header.Get("Origin") != "" {
		http.Error(w, "browser cannot publish", 403)
		return
	}
	upgrader := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }, ReadBufferSize: 4096, WriteBufferSize: 4096}
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	g.agentHandlers.Add(1)
	defer g.agentHandlers.Done()
	logConnection("cloud-bridge", "open", diagnosticID, "", "upgrade", nil, started)
	defer logConnection("cloud-bridge", "closed", diagnosticID, "", "handler_exit", nil, started)
	defer conn.Close()
	conn.SetReadLimit(2 << 20)
	_ = conn.SetReadDeadline(time.Now().Add(45 * time.Second))
	conn.SetPongHandler(func(string) error { return conn.SetReadDeadline(time.Now().Add(45 * time.Second)) })
	a := &agent{conn: conn, id: nonce()}
	g.mu.Lock()
	g.controlMu.Lock()
	previous := g.bridge
	g.bridge = a
	g.controlMu.Unlock()
	resumeEpoch, ack := g.agentEpoch, g.agentSeq
	g.mu.Unlock()
	if previous != nil {
		logConnection("cloud-bridge", "replaced", diagnosticID, "", "new_bridge", nil, started)
		_ = previous.conn.Close()
		g.failBridgeCalls(previous)
	}
	defer func() {
		g.controlMu.Lock()
		disconnected := g.bridge == a
		if g.bridge == a {
			g.bridge = nil
			g.nativeOnline = false
			for _, c := range g.pending {
				if c.source != a {
					continue
				}
				select {
				case c.reply <- reply{Error: "Mac 连接中断；请求结果待核对"}:
				default:
				}
			}
		}
		g.controlMu.Unlock()
		if disconnected {
			g.mu.Lock()
			if !g.hasBridge() {
				for key := range g.topics {
					p := strings.SplitN(key, ":", 2)
					online := false
					g.publishLocked(p[0], p[1], Event{Type: "host", Online: &online})
				}
			}
			g.mu.Unlock()
		}
	}()
	cacheID, persistence := g.cacheIdentity()
	_ = a.send(map[string]any{"type": "hello", "serverEpoch": g.epoch, "adapterEpoch": resumeEpoch, "ack": ack, "protocol": 2, "storeID": cacheID, "projectionRecoveryVersion": 1, "cachePersistence": persistence})
	done := make(chan struct{})
	publications := newPublicationQueue()
	workerStopped := make(chan struct{})
	go g.consumePublications(a, publications, done, workerStopped)
	defer func() { conn.Close(); g.failBridgeCalls(a); close(done); <-workerStopped }()
	go func() {
		ticker := time.NewTicker(15 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				if err := conn.WriteControl(websocket.PingMessage, nil, time.Now().Add(5*time.Second)); err != nil {
					logConnection("cloud-bridge", "failed", diagnosticID, "", "ping_failed", err, started)
					conn.Close()
					return
				}
			case <-done:
				return
			}
		}
	}()
	chunks := map[string]*assembly{}
	for {
		_, raw, err := conn.ReadMessage()
		if err != nil {
			logConnection("cloud-bridge", "failed", diagnosticID, "", "read_failed", err, started)
			return
		}
		_ = conn.SetReadDeadline(time.Now().Add(45 * time.Second))
		var f frame
		if json.Unmarshal(raw, &f) != nil {
			logConnection("cloud-bridge", "rejected", diagnosticID, "", "invalid_json", nil, started)
			return
		}
		if f.Type == "cancel-read-chunks" {
			if v := chunks[f.MessageID]; v != nil && v.readID != "" && v.readID == f.ReadID && v.scope == f.Scope {
				delete(chunks, f.MessageID)
			}
			continue
		}
		if f.Type == "chunk" {
			if f.Count < 1 || f.Count > 1536 || f.Index < 0 || f.Index >= f.Count || len(f.MessageID) > 80 || len(f.ReadID) > 100 {
				return
			}
			part, err := base64.StdEncoding.DecodeString(f.Payload)
			if err != nil || len(part) > 65536 {
				return
			}
			for k, v := range chunks {
				if time.Since(v.at) > 30*time.Second || v.readID != "" && !g.currentRead(a, v.readID, v.scope) {
					delete(chunks, k)
				}
			}
			if f.ReadID != "" && !g.currentRead(a, f.ReadID, f.Scope) {
				continue
			}
			v := chunks[f.MessageID]
			if v == nil {
				if len(chunks) >= 8 || f.Index != 0 {
					return
				}
				v = &assembly{parts: make([][]byte, f.Count), at: time.Now(), readID: f.ReadID, scope: f.Scope}
				chunks[f.MessageID] = v
			}
			if v.next != f.Index || len(v.parts) != f.Count || v.readID != f.ReadID || v.scope != f.Scope {
				return
			}
			v.parts[f.Index] = part
			v.next++
			v.at = time.Now()
			v.size += len(part)
			if v.size > 64<<20 {
				return
			}
			if v.next < f.Count {
				continue
			}
			raw = []byte{}
			for _, part := range v.parts {
				raw = append(raw, part...)
			}
			delete(chunks, f.MessageID)
			if json.Unmarshal(raw, &f) != nil {
				return
			}
			if v.readID != "" && (f.Type != "reply" || f.ID != v.readID) {
				return
			}
		}
		switch f.Type {
		case "reset", "publish":
			if !publications.offer(f, len(raw)) {
				logConnection("cloud-bridge", "closed", diagnosticID, "", "publication_backpressure", nil, started)
				return
			}
		case "reply":
			g.receiveReply(a, f, publications)
		}
	}
}
func (g *Gateway) browserAllowed(r *http.Request) bool {
	if !g.local && r.Header.Get("X-DSH-Authenticated") != "1" {
		return false
	}
	// Authentication remains mandatory. Installed-PWA/SSO document navigation
	// is distinct from cross-origin API access, matching the original front.
	if r.Method == "GET" && (r.URL.Path == "/" || r.URL.Path == "/app" || strings.HasPrefix(r.URL.Path, "/app/thread/")) {
		mode, dest := r.Header.Get("Sec-Fetch-Mode"), r.Header.Get("Sec-Fetch-Dest")
		accept := r.Header.Get("Accept")
		legacy := mode == "" && dest == "" && (accept == "" || accept == "*/*" || strings.Contains(accept, "text/html"))
		if mode == "navigate" && (dest == "" || dest == "document" || dest == "empty") || legacy {
			return true
		}
	}
	origin := r.Header.Get("Origin")
	if origin != "" && origin != g.origin {
		return false
	}
	return r.Header.Get("Sec-Fetch-Site") != "cross-site"
}
func (g *Gateway) serveEvents(w http.ResponseWriter, r *http.Request, scope, id string) {
	origin := r.Header.Get("Origin")
	if origin != g.origin {
		http.Error(w, "invalid origin", 403)
		return
	}
	diagnosticID, started := r.URL.Query().Get("dshDiag"), time.Now()
	// A fixed diagnostic hint distinguishes the native background connection
	// from WebView/browser listeners; it never participates in authentication.
	clientKind := "unknown"
	ua := r.UserAgent()
	if strings.HasPrefix(ua, "okhttp/") {
		clientKind = "android-native"
	} else if strings.Contains(ua, "DSHAndroid/") {
		clientKind = "android-webview"
	} else if strings.Contains(ua, "Chrome/") {
		clientKind = "browser"
	}
	eventLog := func(stage, reason string, failure error) {
		event := connectionEvent("cloud-events", stage, diagnosticID, scope, reason, failure, started)
		event["clientKind"] = clientKind
		raw, _ := json.Marshal(event)
		log.Print(string(raw))
	}

	upgrader := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	eventLog("open", "upgrade", nil)
	defer eventLog("closed", "handler_exit", nil)
	b := &browser{conn: conn, send: make(chan any, 1024), done: make(chan struct{})}
	defer b.close()
	after, _ := strconv.ParseUint(r.URL.Query().Get("after"), 10, 64)
	epoch := r.URL.Query().Get("epoch")
	g.mu.Lock()
	t := g.topicLocked(scope, id)
	t.Subscribers[b] = true
	if epoch != g.epoch || after > t.Seq || (after < t.Seq && (len(t.Events) == 0 || after+1 < t.Events[0].Seq)) {
		b.send <- map[string]any{"type": "resync", "reason": "cursor_expired", "epoch": g.epoch, "seq": t.Seq}
	} else {
		for _, e := range t.Events {
			if e.Seq > after {
				select {
				case b.send <- e:
				default:
					b.close()
				}
			}
		}
	}
	online := g.nativeOnlineNow()
	b.send <- map[string]any{"type": "hello", "epoch": g.epoch, "online": online, "syncPolicyVersion": 1}
	g.mu.Unlock()
	defer func() { g.mu.Lock(); delete(t.Subscribers, b); g.mu.Unlock() }()
	g.refresh(scope, id)
	conn.SetReadLimit(2048)
	// One heartbeat owner. Only this read-only subscriber can opt into quiet
	// keepalive; the Mac replication bridge and command transport are unchanged.
	policyChanges := make(chan eventHeartbeatPolicy, 1)
	readBudget := 45 * time.Second // reader goroutine, including pong callback
	_ = conn.SetReadDeadline(time.Now().Add(readBudget))
	conn.SetPongHandler(func(string) error { return conn.SetReadDeadline(time.Now().Add(readBudget)) })
	go func() {
		defer b.close()
		for {
			var value struct {
				Type string `json:"type"`
				Seq  uint64 `json:"seq"`
				Mode string `json:"mode"`
			}
			if err := conn.ReadJSON(&value); err != nil {
				eventLog("failed", "read_failed", err)
				return
			}
			if value.Type == "syncPolicy" {
				policy, ok := subscriberHeartbeat(value.Mode)
				if !ok {
					return
				}
				readBudget = 3 * policy.interval
				// Latest desired mode replaces an unconsumed old mode. This is
				// not a command queue and never carries execution requests.
				select {
				case <-policyChanges:
				default:
				}
				policyChanges <- policy
				_ = conn.SetReadDeadline(time.Now().Add(readBudget))
				continue
			}
			_ = conn.SetReadDeadline(time.Now().Add(readBudget))
			if value.Type != "ack" && value.Type != "ping" {
				return
			}
		}
	}()
	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()
	adaptiveKeepalive := false
	for {
		select {
		case policy := <-policyChanges:
			adaptiveKeepalive = true
			ticker.Reset(policy.interval)
			_ = conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if err := conn.WriteJSON(map[string]any{"type": "syncPolicy", "mode": policy.mode, "heartbeatMs": policy.interval.Milliseconds()}); err != nil {
				return
			}
		case value := <-b.send:
			_ = conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if err := conn.WriteJSON(value); err != nil {
				eventLog("failed", "write_failed", err)
				return
			}
		case <-ticker.C:
			if adaptiveKeepalive {
				// One application heartbeat is observable by the mobile client.
				// Its ping reply extends the same reader deadline; no second pinger.
				_ = conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
				if conn.WriteJSON(map[string]any{"type": "heartbeat"}) != nil {
					return
				}
			} else if conn.WriteControl(websocket.PingMessage, nil, time.Now().Add(5*time.Second)) != nil {
				return
			}
		case <-b.done:
			return
		}
	}
}
func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
func (g *Gateway) Handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "same-origin")
		w.Header().Set("Accept-CH", "Sec-CH-Prefers-Color-Scheme")
		if r.URL.Path == "/__sync_health" {
			g.mu.Lock()
			online := g.nativeOnlineNow()
			count := len(g.topics)
			g.mu.Unlock()
			writeJSON(w, 200, map[string]any{"service": "dsh-sync-gateway", "online": online, "topics": count, "build": buildVersion, "notifications": g.push != nil && g.push.notificationAvailable(), "cache": g.cacheStatus()})
			return
		}
		if r.URL.Path == "/_sync-agent" {
			g.serveAgent(w, r)
			return
		}
		if !g.browserAllowed(r) {
			http.Error(w, "authentication required", 401)
			return
		}
		if g.serveNativeShell(w, r) {
			return
		}
		if strings.HasPrefix(r.URL.Path, "/app/thread/") && r.Method == "GET" {
			id := strings.TrimPrefix(r.URL.Path, "/app/thread/")
			if !validID(id) {
				http.NotFound(w, r)
				return
			}
			scope := r.URL.Query().Get("workspace")
			if !validScope(scope) {
				scope = "ai"
			}
			w.Header().Set("Cache-Control", "no-store")
			http.Redirect(w, r, "/local/"+id+"?workspace="+scope, 303)
			return
		}
		if r.URL.Path == "/app" && r.Method == "GET" {
			scope := r.URL.Query().Get("workspace")
			if !validScope(scope) {
				scope = "ai"
			}
			w.Header().Set("Cache-Control", "no-store")
			http.Redirect(w, r, "/?workspace="+scope+"&view=chat&nativeList=1", 303)
			return
		}
		if r.URL.Path == "/" {
			scope := r.URL.Query().Get("workspace")
			if !validScope(scope) {
				scope = "ai"
			}
			http.Redirect(w, r, "/?workspace="+scope+"&view=chat&nativeList=1", 303)
			return
		}
		for url, file := range map[string]string{
			"/official-patched-v1002/assets/app-initial-cadb12d4a15e.js": "/opt/dsh-sync/native-assets/v1002/app-initial-cadb12d4a15e.js",
			"/official-patched-v1004/assets/app-initial-cadb12d4a15e.js": "/opt/dsh-sync/native-assets/v1004/app-initial-cadb12d4a15e.js",
			"/official-patched-v1004/assets/app-primary-6cd7b8b3f5e3.js": "/opt/dsh-sync/native-assets/v1004/app-primary-6cd7b8b3f5e3.js",
		} {
			if r.URL.Path != url {
				continue
			}
			w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
			w.Header().Set("Cache-Control", "private, max-age=31536000, immutable")
			http.ServeFile(w, r, file)
			return
		}
		if r.URL.Path == "/app/sw.js" || r.URL.Path == "/app/manifest.webmanifest" || r.URL.Path == "/manifest.webmanifest" {
			name := "manifest.webmanifest"
			w.Header().Set("Content-Type", "application/manifest+json")
			if r.URL.Path == "/app/sw.js" {
				name = "sw.js"
				w.Header().Set("Content-Type", "application/javascript")
				w.Header().Set("Service-Worker-Allowed", "/app")
			}
			w.Header().Set("Cache-Control", "no-cache")
			data, _ := assets.ReadFile("public/" + name)
			if name == "manifest.webmanifest" {
				var manifest map[string]any
				_ = json.Unmarshal(data, &manifest)
				color := "#ffffff"
				mode := r.URL.Query().Get("theme")
				if mode == "" {
					if c, err := r.Cookie("dsh-theme"); err == nil {
						mode = c.Value
					} else if strings.Contains(r.Header.Get("Sec-CH-Prefers-Color-Scheme"), "dark") {
						mode = "dark"
					}
				}
				scope := r.URL.Query().Get("workspace")
				if !validScope(scope) {
					scope = "ai"
				}
				manifest["id"] = "/workspaces/" + scope
				manifest["name"] = "Codex · " + strings.ToUpper(scope)
				manifest["short_name"] = "Codex " + strings.ToUpper(scope)
				manifest["start_url"] = "/?workspace=" + scope + "&view=chat&nativeList=1&pwa=" + scope + "&launch=1"
				manifest["scope"] = "/"
				w.Header().Set("Vary", "Cookie, Sec-CH-Prefers-Color-Scheme")
				if mode == "dark" {
					color = "#000000"
				}
				manifest["background_color"] = color
				manifest["theme_color"] = color
				data, _ = json.Marshal(manifest)
			}
			_, _ = w.Write(data)
			return
		}
		if strings.HasPrefix(r.URL.Path, "/app/assets/") {
			if r.Method != "GET" && r.Method != "HEAD" {
				http.Error(w, "method", 405)
				return
			}
			name := strings.TrimPrefix(r.URL.Path, "/app/assets/")
			if strings.Contains(name, "/") || strings.Contains(name, "..") {
				http.NotFound(w, r)
				return
			}
			if data, err := assets.ReadFile("public/" + name); err == nil {
				sum := sha256.Sum256(data)
				tag := `"` + hex.EncodeToString(sum[:16]) + `"`
				w.Header().Set("ETag", tag)
				if r.Header.Get("If-None-Match") == tag {
					w.Header().Set("Cache-Control", "private, no-cache")
					w.WriteHeader(304)
					return
				}
			}
			sub, _ := fs.Sub(assets, "public")
			w.Header().Set("Cache-Control", "private, no-cache")
			http.StripPrefix("/app/assets/", http.FileServer(http.FS(sub))).ServeHTTP(w, r)
			return
		}
		if r.URL.Path == "/app" || strings.HasPrefix(r.URL.Path, "/app/thread/") {
			if r.Method != "GET" {
				http.Error(w, "method", 405)
				return
			}
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.Header().Set("Cache-Control", "no-store")
			w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'sha256-X5t6fu7gAQKQ2N27Fo/+fnF2iybwU4eXxaIuDLLs2Fg='; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'")
			data, _ := assets.ReadFile("public/index.html")
			_, _ = w.Write(data)
			return
		}
		parts := strings.Split(strings.Trim(r.URL.Path, "/"), "/")
		if len(parts) < 5 || parts[0] != "sync" || parts[1] != "v1" || parts[2] != "w" || !validScope(parts[3]) {
			http.NotFound(w, r)
			return
		}
		scope, op := parts[3], parts[4]
		if strings.HasPrefix(op, "push-") && len(parts) == 5 {
			g.servePush(w, r, scope, op)
			return
		}
		id := ""
		if len(parts) > 5 {
			id = parts[5]
		}
		if id != "" && !validID(id) {
			http.Error(w, "invalid thread", 400)
			return
		}
		if op == "native-cursors" && r.Method == "GET" {
			g.serveNativeCursors(w, r, scope)
			return
		}
		if op == "native-bootstrap" && r.Method == "GET" {
			traceNativeHTTP(w, r, scope, "native_bootstrap", "GET", func(w http.ResponseWriter) {
				g.serveNativeBootstrap(w, r, scope)
			})
			return
		}
		if op == "native-catalog" && r.Method == "GET" {
			traceNativeHTTP(w, r, scope, "native_catalog", "GET", func(w http.ResponseWriter) {
				g.serveNativeCatalog(w, r, scope)
			})
			return
		}
		if op == "native-read" && r.Method == "POST" {
			traceNativeHTTP(w, r, scope, "native_read", "POST", func(w http.ResponseWriter) {
				g.serveNativeRead(w, r, scope)
			})
			return
		}
		if op == "performance" {
			g.servePerformance(w, r, scope)
			return
		}
		if op == "events" && r.Method == "GET" {
			g.serveEvents(w, r, scope, id)
			return
		}
		if op == "threads" && r.Method == "GET" {
			g.serveCatalog(w, r, scope)
			return
		}

		if op == "thread" && r.Method == "GET" && id != "" {
			traceNativeHTTP(w, r, scope, "native_read", "thread/read", func(w http.ResponseWriter) {
				g.serveSnapshot(w, r, scope, id)
			})
			return
		}

		if op == "request" && r.Method == "GET" {
			ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
			defer cancel()
			result, err := g.call(ctx, scope, "request-status", map[string]any{"requestId": r.URL.Query().Get("id")})
			if err != nil {
				writeJSON(w, 503, map[string]any{"error": err.Error()})
				return
			}
			writeJSON(w, 200, json.RawMessage(result))
			return
		}
		if op == "command" && r.Method == "POST" {
			if r.Header.Get("Origin") != g.origin {
				http.Error(w, "origin required", 403)
				return
			}
			r.Body = http.MaxBytesReader(w, r.Body, 256<<10)
			var body map[string]any
			decoder := json.NewDecoder(r.Body)
			if decoder.Decode(&body) != nil {
				http.Error(w, "invalid request", 400)
				return
			}
			requestID, _ := body["requestId"].(string)
			if !validID(requestID) {
				http.Error(w, "invalid request identity", 400)
				return
			}
			ctx, cancel := context.WithTimeout(r.Context(), 25*time.Second)
			defer cancel()
			result, err := g.call(ctx, scope, "command", body)
			if err != nil {
				writeJSON(w, 202, map[string]any{"state": "unknown", "requestId": requestID, "error": err.Error()})
				return
			}
			writeJSON(w, 200, json.RawMessage(result))
			return
		}
		if op == "approval-details" && r.Method == "GET" && id != "" {
			ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
			defer cancel()
			result, err := g.call(ctx, scope, "approval-details", map[string]any{"threadId": id, "approvalId": r.URL.Query().Get("approvalId")})
			if err != nil {
				writeJSON(w, 503, map[string]any{"error": err.Error()})
				return
			}
			writeJSON(w, 200, json.RawMessage(result))
			return
		}
		if op == "details" && r.Method == "GET" && id != "" {
			ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
			defer cancel()
			result, err := g.call(ctx, scope, "details", map[string]any{"threadId": id, "turnId": r.URL.Query().Get("turnId"), "cursor": r.URL.Query().Get("cursor")})
			if err != nil {
				writeJSON(w, 503, map[string]any{"error": err.Error()})
				return
			}
			writeJSON(w, 200, json.RawMessage(result))
			return
		}
		http.NotFound(w, r)
	})
}
func main() {
	listen := flag.String("listen", "127.0.0.1:18985", "")
	dir := flag.String("state-dir", "", "")
	keyFile := flag.String("key-file", "", "")
	origin := flag.String("origin", "", "Required public origin")
	local := flag.Bool("local-development", false, "")
	flag.Parse()
	host, _, err := net.SplitHostPort(*listen)
	if err != nil || net.ParseIP(host) == nil || !net.ParseIP(host).IsLoopback() {
		log.Fatal("loopback listener required")
	}
	parsed, err := url.Parse(*origin)
	if err != nil || parsed.Host == "" {
		log.Fatal("origin required")
	}
	if *local && parsed.Hostname() != "127.0.0.1" && parsed.Hostname() != "localhost" {
		log.Fatal("local development requires loopback origin")
	}
	if *dir == "" || *keyFile == "" {
		log.Fatal("state-dir and key-file required")
	}
	key, err := os.ReadFile(*keyFile)
	if err != nil {
		log.Fatal("bridge credential unavailable")
	}
	key = []byte(strings.TrimSpace(string(key)))
	if len(key) < 32 {
		log.Fatal("invalid bridge credential")
	}
	abs, _ := filepath.Abs(*dir)
	g := NewGateway(abs, *origin, key, *local)
	if err := g.enableRealtimeCache(); err != nil {
		log.Fatal("live read replica unavailable")
	}
	defer g.closeCaches()
	defer g.flush()
	server := &http.Server{Addr: *listen, Handler: g.Handler(), ReadHeaderTimeout: 10 * time.Second, MaxHeaderBytes: 32 << 10}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	go g.runHistoryRetention(ctx)
	g.push, err = newPushService(g)
	if err != nil {
		log.Print("notification service unavailable")
	} else {
		go g.push.run(ctx)
	}
	go func() {
		ticker := time.NewTicker(time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				g.flush()
			case <-ctx.Done():
				g.flush()
				return
			}
		}
	}()
	go func() {
		<-ctx.Done()
		c, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = server.Shutdown(c)
	}()
	fmt.Printf("{\"service\":\"dsh-sync-gateway\",\"listen\":%q}\n", *listen)
	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatal("gateway stopped")
	}
}

var _ = io.EOF
