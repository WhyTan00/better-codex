package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"log"
	"time"
)

// Correlate HTTP, bridge and adapter stages without retaining request bodies,
// cursors, URLs, native errors or history content.
type nativeReadTraceKey struct{}
type nativeReadTrace struct {
	scope, traceID, method, threadID, readIDHash, bridgeID string
	started                                                time.Time
}

func newNativeReadTrace(scope, traceID, method, threadID string) *nativeReadTrace {
	t := &nativeReadTrace{scope: scope, traceID: traceID, method: method, threadID: threadID, bridgeID: nonce(), started: time.Now()}
	digest := sha256.Sum256([]byte(t.bridgeID))
	t.readIDHash = hex.EncodeToString(digest[:8])
	return t
}

func (t *nativeReadTrace) event(stage, phase string, fields map[string]any) {
	if t == nil || !validScope(t.scope) {
		return
	}
	v := map[string]any{"event": "read", "component": "native-read", "at": time.Now().UTC().Format(time.RFC3339Nano),
		"scope": t.scope, "stage": stage, "readPhase": phase, "method": t.method, "durationMs": time.Since(t.started).Milliseconds()}
	if diagnosticUUID.MatchString(t.traceID) {
		v["traceId"] = t.traceID
	}
	if validID(t.threadID) {
		v["threadId"] = t.threadID
	}
	if t.readIDHash != "" {
		v["readIdHash"] = t.readIDHash
	}
	for _, key := range []string{"pendingRequests", "recordRevision", "statusCode", "targetSequence", "ack", "failureStage", "failureClass", "phaseDurationMs", "dbWaitMs", "sqlReadMs", "decodeMs", "responseBytes", "cacheHit", "controlLockMs", "publicationQueueFrames", "publicationQueueBytes", "sourceVerified", "projectionCommitted"} {
		if value, ok := fields[key]; ok {
			v[key] = value
		}
	}
	raw, _ := json.Marshal(v)
	log.Print(string(raw))
}

func nativeReadTraceFrom(ctx context.Context, id string) *nativeReadTrace {
	t, _ := ctx.Value(nativeReadTraceKey{}).(*nativeReadTrace)
	if t != nil {
		digest := sha256.Sum256([]byte(id))
		t.readIDHash = hex.EncodeToString(digest[:8])
	}
	return t
}

func safeReadFailureStage(value string) string {
	switch value {
	case "native_connect", "cache_read", "cache_lookup", "native_read", "local_commit", "publish_ack", "cloud_reuse", "reply_queue":
		return value
	default:
		return "unknown"
	}
}
