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

func TestSetPinned(t *testing.T) {
	path := filepath.Join(t.TempDir(), "conversations.json")
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Touch("a", "/work"); err != nil {
		t.Fatal(err)
	}
	if err := s.SetPinned("a", true); err != nil {
		t.Fatal(err)
	}
	if rec, _ := s.Get("a"); !rec.Pinned {
		t.Fatal("置顶没有落库")
	}
	// 置顶只是排序偏好：自动恢复（LastFor）不受影响。
	if rec, ok := s.LastFor("/work"); !ok || rec.ID != "a" {
		t.Fatalf("LastFor = %+v, %v", rec, ok)
	}
	// Ensure 只补空字段，不能把用户状态冲掉。
	if err := s.Ensure(Record{ID: "a", Cwd: "/work"}); err != nil {
		t.Fatal(err)
	}
	if rec, _ := s.Get("a"); !rec.Pinned {
		t.Fatalf("Ensure 覆盖了置顶: %+v", rec)
	}

	again, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	if rec, ok := again.Get("a"); !ok || !rec.Pinned {
		t.Fatalf("置顶没有持久化: %+v, %v", rec, ok)
	}
	if err := again.SetPinned("missing", true); !errors.Is(err, ErrNotFound) {
		t.Fatalf("SetPinned missing = %v", err)
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

// `/clear` 让 claude 换了会话 id：记录要跟着搬，否则重开对话时按旧 id --resume
// 会把用户刚刚清掉的上下文又读回来。
func TestRekeyMovesRecord(t *testing.T) {
	path := filepath.Join(t.TempDir(), "conversations.json")
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Ensure(Record{ID: "old", Cwd: "/work", Title: "我的对话", Pinned: true}); err != nil {
		t.Fatal(err)
	}

	if err := s.Rekey("old", "new"); err != nil {
		t.Fatalf("Rekey: %v", err)
	}
	// 旧 id 上留一份墓碑指向新对话，但没有内容：旧转录还在磁盘上，不留墓碑的话
	// 列表会把「清空前」那条重新扫出来，侧栏同时出现两条。
	if old, ok := s.Get("old"); !ok || old.SupersededBy != "new" {
		t.Fatalf("旧 id 上应当留一份指向 new 的墓碑，得到 %+v (ok=%v)", old, ok)
	}
	rec, ok := s.Get("new")
	if !ok {
		t.Fatal("新 id 上没有记录")
	}
	if rec.ID != "new" || rec.Title != "我的对话" || rec.Cwd != "/work" || !rec.Pinned {
		t.Fatalf("迁移后的记录 = %+v", rec)
	}
	if rec.SupersededBy != "" {
		t.Fatalf("新记录不该带墓碑标记: %+v", rec)
	}

	// 落盘过了才算真迁：进程重启后要还是新 id。
	s2, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := s2.Get("new"); !ok {
		t.Fatal("迁移没有落盘")
	}
	if old, ok := s2.Get("old"); !ok || old.SupersededBy != "new" {
		t.Fatal("墓碑没有落盘")
	}
	// 被取代的那条不能是「默认恢复哪一条」。
	if last, ok := s2.LastFor("/work"); ok && last.ID == "old" {
		t.Fatal("被 /clear 取代的历史不该成为默认恢复目标")
	}
}

// 旧记录不存在（这条对话没登记过元数据）不算错误，返回 ErrNotFound 让调用方忽略。
func TestRekeyMissingIsErrNotFound(t *testing.T) {
	s, _ := Open(filepath.Join(t.TempDir(), "conversations.json"))
	if err := s.Rekey("nope", "new"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("err = %v, want ErrNotFound", err)
	}
}

// 新 id 上已经有独立记录时**不能覆盖**：那说明用户重新打开过它，
// 盖掉等于吞并对方的标题/置顶/归档状态。
func TestRekeyDoesNotOverwriteExisting(t *testing.T) {
	s, _ := Open(filepath.Join(t.TempDir(), "conversations.json"))
	if err := s.Ensure(Record{ID: "old", Cwd: "/a", Title: "旧的"}); err != nil {
		t.Fatal(err)
	}
	if err := s.Ensure(Record{ID: "new", Cwd: "/b", Title: "已存在"}); err != nil {
		t.Fatal(err)
	}
	if err := s.Rekey("old", "new"); err == nil {
		t.Fatal("目标 id 已存在时应当报错")
	}
	if rec, _ := s.Get("new"); rec.Title != "已存在" {
		t.Fatalf("目标记录被覆盖了: %+v", rec)
	}
	if _, ok := s.Get("old"); !ok {
		t.Fatal("迁移失败时不该删掉旧记录")
	}
}

// 软删除 / 归档状态要一起搬过去，不能因为迁移把它复活。
func TestRekeyKeepsDeletedFlag(t *testing.T) {
	s, _ := Open(filepath.Join(t.TempDir(), "conversations.json"))
	if err := s.Ensure(Record{ID: "old", Cwd: "/w"}); err != nil {
		t.Fatal(err)
	}
	if err := s.Delete("old"); err != nil {
		t.Fatal(err)
	}
	if err := s.Rekey("old", "new"); err != nil {
		t.Fatalf("Rekey: %v", err)
	}
	rec, ok := s.Get("new")
	if !ok {
		t.Fatal("新 id 上没有记录")
	}
	if !rec.Deleted {
		t.Fatal("墓碑没有跟着迁移，已删除的对话被复活了")
	}
}
