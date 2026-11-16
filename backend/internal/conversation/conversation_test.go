package conversation

import (
	"encoding/json"
	"errors"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestTouchRenameArchiveDeleteAndReload(t *testing.T) {
	path := filepath.Join(t.TempDir(), "conversations.json")
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := s.LastFor("/work"); ok {
		t.Fatal("空存储不应有最近对话")
	}
	if err := s.Touch("id-1", "/work/a"); err != nil {
		t.Fatal(err)
	}
	if err := s.Touch("id-2", "/work/a"); err != nil {
		t.Fatal(err)
	}
	// 确保 id-2 更晚，作为最近对话。
	time.Sleep(2 * time.Millisecond)
	if err := s.Touch("id-2", "/work/a"); err != nil {
		t.Fatal(err)
	}
	rec, ok := s.LastFor("/work")
	if !ok || rec.ID != "id-2" {
		t.Fatalf("LastFor = %+v, %v", rec, ok)
	}
	if err := s.Rename("id-2", "  自定义标题  "); err != nil {
		t.Fatal(err)
	}
	if err := s.SetArchived("id-2", true); err != nil {
		t.Fatal(err)
	}
	if rec, ok := s.LastFor("/work"); ok && rec.ID == "id-2" {
		t.Fatal("归档后不应再被 LastFor 选中")
	}
	if err := s.SetArchived("id-2", false); err != nil {
		t.Fatal(err)
	}
	if err := s.Delete("id-1"); err != nil {
		t.Fatal(err)
	}
	if err := s.Rename("missing", "x"); err != ErrNotFound {
		t.Fatalf("Rename missing = %v", err)
	}

	again, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	rec, ok = again.Get("id-2")
	if !ok || rec.Title != "自定义标题" || rec.LastActive.IsZero() {
		t.Fatalf("reload = %+v, %v", rec, ok)
	}
	if rec, ok := again.Get("id-1"); !ok || !rec.Deleted {
		t.Fatalf("删除墓碑未持久化: %+v, %v", rec, ok)
	}
}

func TestLastForNestedAndUpdateMeta(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "conversations.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Touch("a", "/work"); err != nil {
		t.Fatal(err)
	}
	if err := s.Touch("b", "/work/sub"); err != nil {
		t.Fatal(err)
	}
	if err := s.UpdateMeta("b", "p", "m", "high"); err != nil {
		t.Fatal(err)
	}
	rec, ok := s.LastFor("/work")
	if !ok || rec.ID != "b" || rec.Provider != "p" || rec.Model != "m" || rec.Effort != "high" {
		t.Fatalf("LastFor = %+v, %v", rec, ok)
	}
	if _, ok := s.LastFor("/other"); ok {
		t.Fatal("无关目录不应命中")
	}
}

func TestEnsureDoesNotOverwriteUserState(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "conversations.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Touch("id", "/work"); err != nil {
		t.Fatal(err)
	}
	if err := s.Rename("id", "keep"); err != nil {
		t.Fatal(err)
	}
	if err := s.SetArchived("id", true); err != nil {
		t.Fatal(err)
	}
	if err := s.Ensure(Record{ID: "id", Cwd: "/work", Title: "history", Archived: false, LastActive: time.Now()}); err != nil {
		t.Fatal(err)
	}
	rec, _ := s.Get("id")
	if rec.Title != "keep" || !rec.Archived {
		t.Fatalf("Ensure 覆盖了用户状态: %+v", rec)
	}
}

func TestSetUsage(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "conversations.json")
	st, err := Open(path)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if err := st.Touch("c1", "/w"); err != nil {
		t.Fatalf("Touch: %v", err)
	}

	usage := json.RawMessage(`{"contextTokens":9312,"contextWindow":200000,"apiMs":22}`)
	if err := st.SetUsage("c1", usage); err != nil {
		t.Fatalf("SetUsage: %v", err)
	}
	// 重新打开：必须从磁盘读回来
	st2, err := Open(path)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	rec, ok := st2.Get("c1")
	if !ok {
		t.Fatal("记录丢失")
	}
	// 落盘用的是缩进格式，比较语义而不是字节
	var got, want map[string]any
	if err := json.Unmarshal(rec.Usage, &got); err != nil {
		t.Fatalf("usage 不是合法 JSON: %v", err)
	}
	if err := json.Unmarshal(usage, &want); err != nil {
		t.Fatalf("want 不是合法 JSON: %v", err)
	}
	if len(got) != len(want) || got["contextTokens"] != want["contextTokens"] || got["apiMs"] != want["apiMs"] {
		t.Fatalf("usage = %s, want %s", rec.Usage, usage)
	}

	// 不存在的对话、非法 JSON、超长快照都要报错
	if err := st.SetUsage("nope", usage); !errors.Is(err, ErrNotFound) {
		t.Fatalf("未知 id 应返回 ErrNotFound: %v", err)
	}
	if err := st.SetUsage("c1", json.RawMessage(`{`)); err == nil {
		t.Fatal("非法 JSON 应报错")
	}
	big := json.RawMessage(`{"x":"` + strings.Repeat("a", maxUsageBytes) + `"}`)
	if err := st.SetUsage("c1", big); err == nil {
		t.Fatal("超长快照应报错")
	}
}
