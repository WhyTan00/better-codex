package main

import (
	"database/sql"
	"encoding/json"
	"regexp"
	"strings"
)

// Only the exact workspace and completed turn can supply a preview.
type pushContentReader interface{ QueryRow(string, ...any) *sql.Row }

var pushCodeBlock = regexp.MustCompile("(?s)" + strings.Repeat(string(rune(96)), 3) + ".*?" + strings.Repeat(string(rune(96)), 3) + "|~~~.*?~~~")
var pushImage = regexp.MustCompile("!\\[[^\\]]*\\]\\([^)]*\\)")
var pushLink = regexp.MustCompile("\\[([^\\]]+)\\]\\([^)]*\\)")

func notificationExcerpt(text string, limit int) string {
	text = pushCodeBlock.ReplaceAllString(text, " ")
	text = pushImage.ReplaceAllString(text, " ")
	text = pushLink.ReplaceAllString(text, "$1")
	lines := strings.Split(text, "\n")
	for i, line := range lines {
		lines[i] = strings.TrimLeft(strings.TrimSpace(line), "#>*-• ")
	}
	text = strings.Join(strings.Fields(strings.NewReplacer("**", "", "__", "", string(rune(96)), "").Replace(strings.Join(lines, " "))), " ")
	runes := []rune(text)
	if len(runes) > limit {
		return string(runes[:limit-1]) + "…"
	}
	return text
}

func completionContent(db pushContentReader, scope, thread, turn string) (string, string) {
	if !validScope(scope) || !validID(thread) || turn == "" {
		return "", ""
	}
	var raw []byte
	var topic durableTopic
	var title, answer string
	if db.QueryRow("SELECT payload FROM topics WHERE key=?", topicKey(scope, thread)).Scan(&raw) == nil && json.Unmarshal(raw, &topic) == nil && topic.Snapshot != nil && topic.Snapshot.Thread.ID == thread {
		title = topic.Snapshot.Thread.Name
		for _, t := range topic.Snapshot.Turns {
			if t.ID != turn || t.Status != "completed" {
				continue
			}
			for _, item := range t.Items {
				if item.Type == "agentMessage" && (item.Phase == "final_answer" || item.Phase == "") && strings.TrimSpace(item.Text) != "" {
					answer = item.Text
				}
			}
		}
	}
	if title == "" {
		var catalog durableTopic
		if db.QueryRow("SELECT payload FROM topics WHERE key=?", topicKey(scope, "")).Scan(&raw) == nil && json.Unmarshal(raw, &catalog) == nil {
			if t, ok := catalog.List[thread]; ok {
				title = t.Name
				if title == "" {
					title = t.Preview
				}
			}
		}
	}
	// The native catalog covers completions before the first display snapshot.
	if title == "" {
		var record NativeRecord
		if db.QueryRow("SELECT payload FROM native_records WHERE scope=? AND key=? AND deleted=0", scope, "thread:"+thread).Scan(&raw) == nil && json.Unmarshal(raw, &record) == nil {
			var entry struct{ DisplayTitle string }
			if json.Unmarshal(record.Payload, &entry) == nil {
				title = entry.DisplayTitle
			}
		}
	}
	return notificationExcerpt(title, 64), notificationExcerpt(answer, 180)
}

func (p *PushService) notificationContent(j pushJob) (string, string) {
	var title, summary string
	_ = p.store.db.QueryRow("SELECT title,summary FROM push_completion_content WHERE scope=? AND thread_id=? AND turn_id=?", j.Scope, j.Thread, j.Turn).Scan(&title, &summary)
	if title == "" || summary == "" {
		freshTitle, freshSummary := completionContent(p.store.db, j.Scope, j.Thread, j.Turn)
		if title == "" {
			title = freshTitle
		}
		if summary == "" {
			summary = freshSummary
		}
	}
	if title == "" {
		title = strings.ToUpper(j.Scope) + " 会话已完成"
	}
	if summary == "" {
		summary = "本轮已完成，点按查看回答。"
	}
	return "Codex · " + title, summary
}
