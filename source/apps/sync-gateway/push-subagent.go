package main

import (
	"encoding/json"
	"strings"
)

// Use the scoped Native catalog; display titles and thread names are not identities.
func completionIsSubagent(db pushContentReader, scope, thread string) bool {
	_, child := completionThreadClassification(db, scope, thread)
	return child
}

func completionThreadClassification(db pushContentReader, scope, thread string) (bool, bool) {
	if !validScope(scope) || !validID(thread) {
		return false, false
	}
	var raw []byte
	if db.QueryRow("SELECT payload FROM native_records WHERE scope=? AND key=? AND deleted=0", scope, "thread:"+thread).Scan(&raw) != nil {
		return false, false
	}
	var record NativeRecord
	if json.Unmarshal(raw, &record) != nil || record.Scope != scope || record.ThreadID != thread {
		return false, false
	}
	var entry struct {
		NativeThread map[string]any `json:"nativeThread"`
	}
	if json.Unmarshal(record.Payload, &entry) != nil || entry.NativeThread["id"] != thread {
		return false, false
	}
	return true, isSubagentThread(entry.NativeThread)
}

func isSubagentThread(thread map[string]any) bool {
	if thread["threadSource"] == "subagent" {
		return true
	}
	if parent, ok := thread["parentThreadId"].(string); ok && strings.TrimSpace(parent) != "" && !strings.EqualFold(strings.TrimSpace(parent), "null") {
		return true
	}
	switch source := thread["source"].(type) {
	case map[string]any:
		_, ok := source["subAgent"].(map[string]any)
		return ok
	case string:
		return source == "subAgentThreadSpawn" || source == "subAgent"
	}
	return false
}
