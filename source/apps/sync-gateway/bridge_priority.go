package main

import (
	"encoding/json"
	"errors"
	"log"
	"strings"
	"sync"
	"time"
)

type pendingCall struct {
	reply  chan reply
	trace  *nativeReadTrace
	source *agent
	op     string
	scope  string
}

// A foreground chunk belongs to one live read on this authenticated bridge.
// Commands and replaced/canceled readers cannot acquire a read assembly.
func (g *Gateway) currentRead(a *agent, id, scope string) bool {
	g.controlMu.Lock()
	defer g.controlMu.Unlock()
	call := g.pending[id]
	return g.bridge == a && call != nil && call.source == a && call.op == "native-read" && call.scope == scope
}

func (g *Gateway) hasBridge() bool {
	g.controlMu.Lock()
	defer g.controlMu.Unlock()
	return g.bridge != nil
}
func (g *Gateway) isCurrentBridge(a *agent) bool {
	g.controlMu.Lock()
	defer g.controlMu.Unlock()
	return g.bridge == a
}
func (g *Gateway) failBridgeCalls(a *agent) {
	g.controlMu.Lock()
	defer g.controlMu.Unlock()
	if g.bridge == a {
		g.nativeOnline = false
	}
	for _, call := range g.pending {
		if call.source != a {
			continue
		}
		select {
		case call.reply <- reply{Error: "Mac 连接中断；请求结果待核对"}:
		default:
		}
	}
}
func (g *Gateway) receiveReply(a *agent, f frame, q *publicationQueue) {
	g.controlMu.Lock()
	call := g.pending[f.ID]
	current := g.bridge == a && call != nil && call.source == a
	g.controlMu.Unlock()
	if !current {
		return
	}
	frames, bytes := q.size()
	call.trace.event("received", "socket_reply", map[string]any{"publicationQueueFrames": frames, "publicationQueueBytes": bytes})
	select {
	case call.reply <- reply{Result: f.Result, Error: f.Error, Status: f.Status, FailureStage: f.FailureStage}:
	default:
	}
}

type queuedPublication struct {
	frame frame
	bytes int
	at    time.Time
}
type publicationQueue struct {
	mu    sync.Mutex
	jobs  chan queuedPublication
	bytes int
}

const maxPublicationFrames = 512

func newPublicationQueue() *publicationQueue {
	return &publicationQueue{jobs: make(chan queuedPublication, maxPublicationFrames)}
}
func (q *publicationQueue) offer(f frame, bytes int) bool {
	q.mu.Lock()
	defer q.mu.Unlock()
	if bytes < 0 || q.bytes+bytes > 64<<20 {
		return false
	}
	select {
	case q.jobs <- queuedPublication{f, bytes, time.Now()}:
		q.bytes += bytes
		return true
	default:
		return false
	}
}
func (q *publicationQueue) taken(job queuedPublication) {
	q.mu.Lock()
	q.bytes -= job.bytes
	q.mu.Unlock()
}
func (q *publicationQueue) size() (int, int) {
	q.mu.Lock()
	defer q.mu.Unlock()
	return len(q.jobs), q.bytes
}

// Only the ordered worker commits source data and advances ACK. The socket
// reader remains free to deliver control replies while an unrelated commit is
// in progress. Overflow closes this bridge without ACK; the durable sender
// replays from the last committed cursor on the existing reconnect path.
func (g *Gateway) consumePublications(a *agent, q *publicationQueue, done <-chan struct{}, stopped chan<- struct{}) {
	defer close(stopped)
	var carry *queuedPublication
	for {
		select {
		case <-done:
			return
		default:
		}
		var job queuedPublication
		if carry != nil {
			job = *carry
			carry = nil
		} else {
			select {
			case <-done:
				return
			case job = <-q.jobs:
				q.taken(job)
			}
		}
		{
			select {
			case <-done:
				return
			default:
			}
			f := job.frame
			var err error
			if f.Type == "reset" {
				err = g.resetFromBridge(a, f)
			} else {
				batch := []queuedPublication{job}
				bytes := job.bytes
			collect:
				for len(batch) < 16 && bytes < 4<<20 {
					select {
					case next := <-q.jobs:
						q.taken(next)
						if next.frame.Type != "publish" || next.frame.Scope != f.Scope || next.frame.Epoch != f.Epoch || bytes+next.bytes > 4<<20 {
							carry = &next
							break collect
						}
						batch = append(batch, next)
						bytes += next.bytes
					default:
						break collect
					}
				}
				err = g.applyBatchFromBridge(batch, a)
				f = batch[len(batch)-1].frame
			}
			if err != nil {
				if strings.Contains(err.Error(), "sequence gap") || strings.Contains(err.Error(), "epoch mismatch") {
					if a.send(map[string]any{"type": "resync", "reason": "sequence_gap"}) != nil {
						a.conn.Close()
						return
					}
					continue
				}
				logConnection("cloud-bridge", "failed", "", "", "publication_commit_failed", nil, job.at)
				a.conn.Close()
				return
			}
			seq := f.Seq
			if f.Type == "reset" {
				seq = f.BaseSeq
			}
			cacheID, persistence := g.cacheIdentity()
			if a.send(map[string]any{"type": "ack", "epoch": f.Epoch, "seq": seq, "storeID": cacheID, "cachePersistence": persistence, "cacheReplica": g.cacheAcceptance()}) != nil {
				a.conn.Close()
				return
			}
			if f.Type == "reset" {
				g.refreshSubscribedTopics()
			}
		}
	}
}

func (g *Gateway) resetFromBridge(a *agent, f frame) error {
	g.persistMu.Lock()
	defer g.persistMu.Unlock()
	g.mu.Lock()
	defer g.mu.Unlock()
	if !g.isCurrentBridge(a) {
		return errors.New("bridge replaced")
	}
	projectionEpoch := ""
	if f.Epoch == g.agentEpoch && f.BaseSeq > g.agentSeq {
		projectionEpoch = nonce()
	}
	if err := g.cacheStore().resetProjection(f.Epoch, f.BaseSeq, projectionEpoch); err != nil {
		if !cacheStorageFailure(err) || g.useMemoryCacheLocked(err) != nil {
			return err
		}
		if err = g.cacheStore().resetProjection(f.Epoch, f.BaseSeq, projectionEpoch); err != nil {
			return err
		}
	}
	g.agentEpoch, g.agentSeq = f.Epoch, f.BaseSeq
	if g.replica != nil {
		if projectionEpoch != "" {
			g.cacheStore().catalogLimited.Store(true)
			g.cacheStore().fallback.Store(nil)
		}
		g.replica.accepted.Store(&replicaCursor{f.Epoch, f.BaseSeq})
		g.mirrorReset(f.Epoch, f.BaseSeq, projectionEpoch)
	}
	g.frameProofs = map[uint64]string{}
	if projectionEpoch != "" {
		g.epoch = projectionEpoch
		for _, topic := range g.topics {
			topic.Events, topic.Bytes = nil, 0
			for subscriber := range topic.Subscribers {
				select {
				case subscriber.send <- map[string]any{"type": "resync", "reason": "projection_rebuilt", "epoch": g.epoch, "seq": topic.Seq}:
				default:
					subscriber.close()
				}
			}
		}
	}
	g.controlMu.Lock()
	g.nativeOnline = true
	g.controlMu.Unlock()
	return nil
}
func (g *Gateway) refreshSubscribedTopics() {
	g.mu.Lock()
	var subscriptions []string
	for key, topic := range g.topics {
		if len(topic.Subscribers) > 0 {
			subscriptions = append(subscriptions, key)
		}
	}
	g.mu.Unlock()
	for _, key := range subscriptions {
		p := strings.SplitN(key, ":", 2)
		g.refresh(p[0], p[1])
	}
}

type publicationMetrics struct {
	CachePersistence string `json:"cachePersistence"`
	BatchFrames      int    `json:"batchFrames"`
	FirstSequence    uint64 `json:"firstSequence"`
	QueueMs          int64  `json:"queueMs"`
	PersistLockMs    int64  `json:"persistLockMs"`
	StateLockMs      int64  `json:"stateLockMs"`
	ProjectionMs     int64  `json:"projectionMs"`
	DBWaitMs         int64  `json:"dbWaitMs"`
	TopicWriteMs     int64  `json:"topicWriteMs"`
	RecencyWriteMs   int64  `json:"recencyWriteMs"`
	NativeWriteMs    int64  `json:"nativeWriteMs"`
	PruneMs          int64  `json:"pruneMs"`
	JournalMs        int64  `json:"journalMs"`
	TransactionMs    int64  `json:"transactionMs"`
	SyncMs           int64  `json:"syncMs"`
	TopicBytes       int    `json:"topicBytes"`
}

func (m *publicationMetrics) log(f frame, duration time.Duration, err error) {
	if !validScope(f.Scope) {
		return
	}
	v := map[string]any{"event": "sync-commit", "component": "gateway-storage", "scope": f.Scope, "at": time.Now().UTC().Format(time.RFC3339Nano), "sequence": f.Seq, "durationMs": duration.Milliseconds(), "frameBytes": len(f.Data), "timings": m, "stage": "committed"}
	if validID(f.ThreadID) {
		v["threadId"] = f.ThreadID
	}
	if err != nil {
		v["stage"] = "failed"
	}
	switch f.Event.Type {
	case "nativeRecord", "delta", "item", "turn", "snapshot", "catalog", "catalogPage", "pins", "historyPage":
		v["publicationType"] = f.Event.Type
	default:
		v["publicationType"] = "other"
	}
	raw, _ := json.Marshal(v)
	log.Print(string(raw))
}
