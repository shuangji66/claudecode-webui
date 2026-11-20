package schedule

import (
	"path/filepath"
	"testing"
)

// `/clear` 让对话换了 id：绑在旧 id 上的任务必须改指新 id。
//
// 不改的话它们之后每一轮都去 `--resume 旧 id`——那份转录正好停在 clear 之前，
// 于是用户刚刚清掉的上下文被当成任务上下文重新读进来，而新 id 上真正的对话
// 永远收不到投递。
func TestRekeyConversationRetargetsTasks(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "schedules.json"))
	if err != nil {
		t.Fatal(err)
	}
	mk := func(name, convID string) Task {
		t.Helper()
		task, err := s.Create(Task{
			Name:   name,
			Prompt: "跑一遍测试",
			Rule:   Rule{Kind: KindDaily, Time: "09:00", Timezone: "Asia/Shanghai"},
			Target: Target{Kind: TargetConversation, ConversationID: convID},
		})
		if err != nil {
			t.Fatalf("Create(%s): %v", name, err)
		}
		return task
	}
	bound := mk("绑旧对话", "old-id")
	other := mk("绑别的对话", "other-id")
	// 新建型任务没有绑定对话（ConversationID 为空），不该被改。
	fresh := mk("每次新建", "")

	if n := s.RekeyConversation("old-id", "new-id"); n != 1 {
		t.Fatalf("改了 %d 条，want 1", n)
	}
	if got, _ := s.Get(bound.ID); got.Target.ConversationID != "new-id" {
		t.Fatalf("绑旧对话的任务 = %q，want new-id", got.Target.ConversationID)
	}
	if got, _ := s.Get(other.ID); got.Target.ConversationID != "other-id" {
		t.Fatalf("别的对话的任务被误改: %q", got.Target.ConversationID)
	}
	if got, _ := s.Get(fresh.ID); got.Target.ConversationID != "" {
		t.Fatalf("没有绑定对话的任务被误改: %q", got.Target.ConversationID)
	}

	// 落盘过了才算真改：进程重启后不能又指回旧 id。
	s2, err := Open(s.Path())
	if err != nil {
		t.Fatal(err)
	}
	if got, _ := s2.Get(bound.ID); got.Target.ConversationID != "new-id" {
		t.Fatalf("改动没有落盘: %q", got.Target.ConversationID)
	}
}

// 没有任务绑在这个 id 上时是空操作，也不该把文件重写一遍。
func TestRekeyConversationNoopOnUnknownID(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "schedules.json"))
	if err != nil {
		t.Fatal(err)
	}
	if n := s.RekeyConversation("nobody", "new-id"); n != 0 {
		t.Fatalf("改了 %d 条，want 0", n)
	}
	if n := s.RekeyConversation("", "new-id"); n != 0 {
		t.Fatalf("空 id 应当忽略，改了 %d 条", n)
	}
	if n := s.RekeyConversation("same", "same"); n != 0 {
		t.Fatalf("同一 id 应当忽略，改了 %d 条", n)
	}
}
