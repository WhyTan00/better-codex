package main

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
	"unicode/utf8"
)

func TestCompletionPreviewUsesExactFinalAnswerAndSurvivesLaterTurn(t *testing.T) {
	g := newPushTest(t)
	subscribeTest(t, g, "ai")
	apply := func(event Event) {
		t.Helper()
		if err := g.apply(frame{Epoch: "test", Seq: g.agentSeq + 1, Scope: "ai", ThreadID: pushThread, Event: event}); err != nil {
			t.Fatal(err)
		}
	}
	snapshot := Snapshot{Thread: Thread{ID: pushThread, Name: "缓存优化验证"}, Turns: []Turn{
		{ID: "00000000-0000-4000-8000-f82fe242e2a8", Status: "completed", Items: []Item{{Type: "agentMessage", Phase: "final_answer", Text: "旧回答不可复用"}}},
		{ID: "00000000-0000-4000-8000-ce3e780abe4a", Status: "inProgress", Items: []Item{
			{Type: "userMessage", Text: "用户输入不能做摘要"},
			{Type: "agentMessage", Phase: "commentary", Text: "还在处理"},
			{Type: "commandExecution", Text: "工具秘密"},
			{Type: "agentMessage", Phase: "final_answer", Text: "**已完成**最近6轮缓存。\n查看[详细说明](https://example.test/private)"},
		}},
	}}
	apply(Event{Type: "snapshot", Snapshot: &snapshot})
	now := float64(time.Now().UnixMilli()) / 1000
	completeTest(t, g, "ai", "00000000-0000-4000-8000-ce3e780abe4a", now)
	j := pushJob{Scope: "ai", Thread: pushThread, Turn: "00000000-0000-4000-8000-ce3e780abe4a"}
	title, body := g.push.notificationContent(j)
	if title != "Codex · 缓存优化验证" || body != "已完成最近6轮缓存。 查看详细说明" {
		t.Fatalf("unexpected preview: %q %q", title, body)
	}
	apply(Event{Type: "snapshot", Snapshot: &Snapshot{Thread: Thread{ID: pushThread, Name: "新标题"}, Turns: []Turn{{ID: "00000000-0000-4000-8000-065ebedd1a42", Status: "completed", Items: []Item{{Type: "agentMessage", Phase: "final_answer", Text: "下一轮回答"}}}}}})
	title, body = g.push.notificationContent(j)
	if title != "Codex · 缓存优化验证" || strings.Contains(body, "下一轮") {
		t.Fatal("queued completion changed with later turn")
	}
	_, other := g.push.notificationContent(pushJob{Scope: "secondary", Thread: pushThread, Turn: "00000000-0000-4000-8000-ce3e780abe4a"})
	if strings.Contains(other, "最近6轮") {
		t.Fatal("cross-workspace preview")
	}
}

func TestMissingFinalAnswerDoesNotUseCommentaryOrPreviousTurn(t *testing.T) {
	g := newPushTest(t)
	payload, _ := json.Marshal(durableTopic{Snapshot: &Snapshot{Thread: Thread{ID: pushThread, Name: "工作"}, Turns: []Turn{{ID: "00000000-0000-4000-8000-f82fe242e2a8", Status: "completed", Items: []Item{{Type: "agentMessage", Phase: "final_answer", Text: "00000000-0000-4000-8000-f82fe242e2a8"}}}, {ID: "new", Status: "completed", Items: []Item{{Type: "agentMessage", Phase: "commentary", Text: "progress"}}}}}})
	if _, err := g.durable.db.Exec("INSERT INTO topics VALUES(?,?)", topicKey("ai", pushThread), payload); err != nil {
		t.Fatal(err)
	}
	_, body := g.push.notificationContent(pushJob{Scope: "ai", Thread: pushThread, Turn: "new"})
	if body != "本轮已完成，点按查看回答。" {
		t.Fatal(body)
	}
}

func TestNotificationExcerptIsUnicodeBoundedAndOmitsCode(t *testing.T) {
	text := "# 结果\n" + strings.Repeat(string(rune(96)), 3) + "shell\nsecret\n" + strings.Repeat(string(rune(96)), 3) + "\n![image](private) **完成** " + strings.Repeat("好", 300)
	got := notificationExcerpt(text, 180)
	if !utf8.ValidString(got) || len([]rune(got)) != 180 || !strings.HasSuffix(got, "…") || strings.Contains(got, "secret") || strings.Contains(got, "private") {
		t.Fatal(got)
	}
}
