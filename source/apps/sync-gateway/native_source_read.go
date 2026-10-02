package main

import "encoding/json"

const sourceReadVersion = 2

func knownSourceReadVersion(version int) bool { return version == 2 || version == 3 }

const maxSourceReadBytes = 256 * 1024 // Legacy version 1 only.
const maxSourcePayloadBytes = 48 << 20
const maxSourceTransferBytes = 64 << 20

func sourceReadEligible(method string, p map[string]any) bool {
	if method == "thread/read" {
		_, valid := p["includeTurns"].(bool)
		return valid
	}
	if p["sortDirection"] != "asc" && p["sortDirection"] != "desc" {
		return false
	}
	if method == "thread/items/list" {
		return true
	}
	view := p["itemsView"]
	return method == "thread/turns/list" && (view == "summary" || view == "notLoaded" || view == "full")
}

func validSourceRead(record NativeRecord, scope, key, threadID, method string, params map[string]any, size int) bool {
	if size > maxSourceTransferBytes || len(record.Payload) > maxSourcePayloadBytes || !sourceReadEligible(method, params) || record.Scope != scope || record.Key != key || record.ThreadID != threadID || record.Kind != "history" || record.Deleted || record.Revision < 1 || record.Revision > 9007199254740991 || record.SourceGeneration == "" || len(record.SourceGeneration) > 128 || record.Generation == "" || len(record.Generation) > 128 || record.Bytes < 0 || record.Bytes > maxSourcePayloadBytes {
		return false
	}
	var payload struct {
		Method string                     `json:"method"`
		Params map[string]any             `json:"params"`
		Result map[string]json.RawMessage `json:"result"`
	}
	if json.Unmarshal(record.Payload, &payload) != nil || payload.Method != method || payload.Result == nil {
		return false
	}
	actual, _ := json.Marshal([]any{method, normalizeNativeParams(method, payload.Params)})
	if "read:"+string(actual) != key {
		return false
	}
	if method == "thread/read" {
		var head struct {
			ID string `json:"id"`
		}
		if json.Unmarshal(payload.Result["thread"], &head) != nil || head.ID != threadID {
			return false
		}
	} else {
		maximum := 20
		if method == "thread/items/list" {
			maximum = 100
		}
		var rows []json.RawMessage
		if json.Unmarshal(payload.Result["data"], &rows) != nil || rows == nil || len(rows) > maximum {
			return false
		}
	}
	return true
}
