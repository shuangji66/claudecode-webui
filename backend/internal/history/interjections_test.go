package history

import (
	"os"
	"path/filepath"
	"testing"
)

// 插话记账的往返：AppendInterjection 写、loadInterjections 读（LoadTranscript 用它）。
//
// 这份文件是「哪些 user 行是插话」的**唯一**来源：转录里 priority=now 与排队投递的
// 消息字段完全相同（实测 2.1.330，18/18 一致），纯转录侧推断不可能对。
func TestAppendAndLoadInterjections(t *testing.T) {
	projects := t.TempDir()
	id := "aaaaaaaa-1111-4222-8333-444444444444"
	projDir := filepath.Join(projects, "-tmp-ws")
	if err := os.MkdirAll(projDir, 0o755); err != nil {
		t.Fatal(err)
	}
	// findTranscript 要求转录文件存在。
	if err := os.WriteFile(filepath.Join(projDir, id+".jsonl"), []byte(`{"type":"user","uuid":"u-1","message":{"content":"q"}}`+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	if err := AppendInterjection(projects, id, "u-2"); err != nil {
		t.Fatalf("AppendInterjection: %v", err)
	}
	if err := AppendInterjection(projects, id, "u-3"); err != nil {
		t.Fatalf("AppendInterjection: %v", err)
	}
	// 重复写不该在名单里出现两次。
	if err := AppendInterjection(projects, id, "u-2"); err != nil {
		t.Fatalf("AppendInterjection: %v", err)
	}

	tr, err := LoadTranscript(projects, id)
	if err != nil {
		t.Fatalf("LoadTranscript: %v", err)
	}
	if len(tr.InterjectedUUIDs) != 2 {
		t.Fatalf("interjected_uuids = %v，期望 2 条（去重后）", tr.InterjectedUUIDs)
	}
	got := map[string]bool{}
	for _, u := range tr.InterjectedUUIDs {
		got[u] = true
	}
	if !got["u-2"] || !got["u-3"] {
		t.Fatalf("名单内容不对: %v", tr.InterjectedUUIDs)
	}
}

// 老会话（没有这份文件）必须正常回放，名单为空。
func TestLoadInterjectionsMissingFile(t *testing.T) {
	projects := t.TempDir()
	id := "bbbbbbbb-1111-4222-8333-444444444444"
	projDir := filepath.Join(projects, "-tmp-ws")
	if err := os.MkdirAll(projDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(projDir, id+".jsonl"), []byte(`{"type":"user","message":{"content":"q"}}`+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	tr, err := LoadTranscript(projects, id)
	if err != nil {
		t.Fatalf("LoadTranscript: %v", err)
	}
	if len(tr.InterjectedUUIDs) != 0 {
		t.Fatalf("没有记账文件时应为空，实际 %v", tr.InterjectedUUIDs)
	}
}
