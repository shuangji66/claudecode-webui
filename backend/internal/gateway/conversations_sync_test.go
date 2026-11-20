package gateway

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"ccweb/backend/internal/agent/manager"
	"ccweb/backend/internal/agent/session"
	"ccweb/backend/internal/conversation"
)

// 跨设备同步：在另一台设备上新建的对话必须出现在本机的侧栏里。
//
// 列表只在 `GET /api/conversations` 里现算（转录 + 元数据 + 存活会话），
// 所以「别的设备发了第一条消息」这件事必须由后端推一条 conversations.changed，
// 否则本机只能等自己下次主动刷新（换工作区、重开页面）才看得到那一行。
//
// 推送时机刻意只在两处：①这条对话第一次进入列表；②这一轮结束（转录落盘，
// 标题与 live/state 定稿）。逐条 prompt 都推会让每个连接的每个回合都去重扫
// 一遍全部转录（history.List 会把每份 jsonl 都打开），在 NAS 上随对话数量线性变贵。
func TestFirstPromptBroadcastsConversationListChange(t *testing.T) {
	srv, mgr, conv, id := newSyncFixture(t)
	rec := &recClient{}
	srv.d.Hub.Subscribe(systemTopic, rec)

	dispatchPrompt(t, srv, mgr, id, "第一个问题")

	if n := len(rec.take()); n != 1 {
		t.Fatalf("新对话的首条消息应推 1 次 conversations.changed，得到 %d", n)
	}
	if _, ok := conv.Get(id); !ok {
		t.Fatal("首条消息应把对话落进元数据（列表靠它显示这一行）")
	}

	// 同一轮的后续消息：列表里已经有这一行，不再推。
	dispatchPrompt(t, srv, mgr, id, "第二个问题")
	if n := len(rec.take()); n != 0 {
		t.Fatalf("后续消息不该再推，得到 %d 次", n)
	}
}

// 这一轮结束时再推一次：那时转录才落盘，标题（转录首条消息）与 live/state 定稿。
// 少了这一步，另一台设备上那一行会永远停在「新对话」。
func TestTurnEndBroadcastsConversationListChange(t *testing.T) {
	srv, mgr, _, id := newSyncFixture(t)
	rec := &recClient{}
	srv.d.Hub.Subscribe(systemTopic, rec)

	dispatchPrompt(t, srv, mgr, id, "第一个问题")
	rec.take() // 首条消息那一次

	// 中间状态（busy）不算回合结束。
	srv.NoteSessionState(id, json.RawMessage(`{"state":"busy"}`))
	if n := len(rec.take()); n != 0 {
		t.Fatalf("busy 不该触发刷新，得到 %d 次", n)
	}

	srv.NoteSessionState(id, json.RawMessage(`{"state":"ready"}`))
	if n := len(rec.take()); n != 1 {
		t.Fatalf("回合结束应推 1 次，得到 %d", n)
	}
	// 标记已消耗：同一条会话不会因为后续状态变化再推。
	srv.NoteSessionState(id, json.RawMessage(`{"state":"ready"}`))
	if n := len(rec.take()); n != 0 {
		t.Fatalf("同一条会话不该重复推，得到 %d 次", n)
	}
}

// 已经有转录的老对话发消息：只改 last_active，不动列表里那一行的样子，
// 因此不该推——否则每发一条消息，所有在线设备都要重扫一遍全部转录。
func TestPromptOnExistingConversationDoesNotBroadcast(t *testing.T) {
	srv, mgr, conv, id := newSyncFixture(t)
	// 老对话：元数据已存在，转录也在（fixture 里种了一份）。
	if err := conv.Touch(id, mgr.cwd()); err != nil {
		t.Fatal(err)
	}
	rec := &recClient{}
	srv.d.Hub.Subscribe(systemTopic, rec)

	dispatchPrompt(t, srv, mgr, id, "再问一句")
	if n := len(rec.take()); n != 0 {
		t.Fatalf("已有转录的老对话不该推，得到 %d 次", n)
	}
	// 也没登记待刷新的回合：这一轮结束时不该冒出一条推送。
	srv.NoteSessionState(id, json.RawMessage(`{"state":"ready"}`))
	if n := len(rec.take()); n != 0 {
		t.Fatalf("没登记过的回合结束时不该推，得到 %d 次", n)
	}
}

// 别处改了会话名（终端 /rename、IDE 插件、--name）要并进对话元数据。
//
// 不接的话不只是「看不见」：用户在这边再改一次名，旧标题会被这边的记录写回去，
// 两边永远对不上。落库走 Rename（自定义标题），与人工重命名同一条路径。
func TestSessionTitleUpdatesConversation(t *testing.T) {
	srv, _, conv, id := newSyncFixture(t)
	if err := conv.Touch(id, srv.d.ProjectsRoot); err != nil {
		t.Fatal(err)
	}
	rec := &recClient{}
	srv.d.Hub.Subscribe(systemTopic, rec)

	srv.NoteSessionTitle(id, json.RawMessage(`{"title":"终端里改的名字","session_id":"`+id+`"}`))
	if events := rec.take(); len(events) != 1 || events[0].Kind != "conversations.changed" {
		t.Fatalf("改名应推 1 条 conversations.changed，得到 %+v", events)
	}
	got, ok := conv.Get(id)
	if !ok {
		t.Fatal("对话记录不见了")
	}
	if got.Title != "终端里改的名字" {
		t.Fatalf("Title = %q", got.Title)
	}

	// 同一个名字重复上报：CLI 明确要求当作没变化，不该再推。
	srv.NoteSessionTitle(id, json.RawMessage(`{"title":"终端里改的名字"}`))
	if events := rec.take(); len(events) != 0 {
		t.Fatalf("重复的标题不该推送，得到 %+v", events)
	}
}

// 还没有元数据的对话（首轮还没跑完就改了名）也要能先收养再写标题，
// 否则那次改名会凭空消失，下一轮又回到首条消息标题。
func TestSessionTitleAdoptsConversationWithoutRecord(t *testing.T) {
	srv, _, conv, id := newSyncFixture(t)

	srv.NoteSessionTitle(id, json.RawMessage(`{"title":"先起个名字"}`))
	got, ok := conv.Get(id)
	if !ok {
		t.Fatal("应收养出一条记录")
	}
	if got.Title != "先起个名字" {
		t.Fatalf("Title = %q", got.Title)
	}
}

// 重命名 / 置顶 / 归档 / 删除都会改变别人侧栏里的那一行（甚至它属于哪个分组），
// 这些都是「列表变了」，必须让别的设备跟着刷新一次。
func TestConversationMutationsBroadcast(t *testing.T) {
	cases := []struct {
		name   string
		do     func(t *testing.T, srv *Server)
		mutate bool
	}{
		{
			name: "重命名",
			do: func(t *testing.T, srv *Server) {
				patchConversation(t, srv, map[string]any{"id": syncFixtureID, "title": "新名字"})
			},
		},
		{
			name: "置顶",
			do: func(t *testing.T, srv *Server) {
				patchConversation(t, srv, map[string]any{"id": syncFixtureID, "pinned": true})
			},
		},
		{
			name: "归档",
			do: func(t *testing.T, srv *Server) {
				patchConversation(t, srv, map[string]any{"id": syncFixtureID, "archived": true})
			},
		},
		{
			name: "删除",
			do: func(t *testing.T, srv *Server) {
				rec := httptest.NewRecorder()
				srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodDelete, "/api/conversations?id="+syncFixtureID, nil))
				if rec.Code != http.StatusOK {
					t.Fatalf("删除失败: %d %s", rec.Code, rec.Body.String())
				}
			},
		},
		{
			name: "分叉",
			do: func(t *testing.T, srv *Server) {
				rec := httptest.NewRecorder()
				body := `{"id":"` + syncFixtureID + `","title":"原件（分叉）"}`
				srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/conversations/fork", strings.NewReader(body)))
				if rec.Code != http.StatusOK {
					t.Fatalf("分叉失败: %d %s", rec.Code, rec.Body.String())
				}
			},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			srv, _, _, _ := newSyncFixture(t)
			rec := &recClient{}
			srv.d.Hub.Subscribe(systemTopic, rec)
			tc.do(t, srv)
			if events := rec.take(); len(events) != 1 || events[0].Kind != "conversations.changed" {
				t.Fatalf("应推 1 条 conversations.changed，得到 %+v", events)
			}
		})
	}
}

// usage 快照与 touch 不改列表里那一行的内容（只影响重开对话时的统计快照与排序），
// 不该触发推送：两者都够频繁（每回合一次 / 每次切对话），推了就是让所有连接
// 跟着重扫一遍全部转录。
func TestConversationUsageAndTouchDoNotBroadcast(t *testing.T) {
	cases := []struct {
		name string
		body map[string]any
	}{
		{name: "用量快照", body: map[string]any{"id": syncFixtureID, "usage": map[string]any{"context_tokens": 100}}},
		{name: "打开即 touch", body: map[string]any{"id": syncFixtureID, "touch": true}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			srv, _, _, _ := newSyncFixture(t)
			rec := &recClient{}
			srv.d.Hub.Subscribe(systemTopic, rec)
			patchConversation(t, srv, tc.body)
			if events := rec.take(); len(events) != 0 {
				t.Fatalf("不该推送，得到 %+v", events)
			}
		})
	}
}

// syncFixtureID 是 fixture 里的对话 id：必须是**合法 session id**
// （history.validSessionID 要求 ≥8 位、只含字母数字与 `-`/`_`），否则
// TranscriptExists 一律返回 false，老对话的用例就退化成新对话。
const syncFixtureID = "aaaaaaaa-1111-4222-8333-444444444444"

// newSyncFixture 装配一个带对话元数据与「已落盘转录」的最小网关。
//
// 会话 cwd 取 ProjectsRoot 下的子目录：fork 会真起进程，先过
// ensureCwdAuthorizedReal 那道围栏；转录种在 HistoryDir 下，让 hasTranscript 成立。
func newSyncFixture(t *testing.T) (*Server, *fakeMgr, *conversation.Store, string) {
	t.Helper()
	srv, mgr := newTestServer(t, "")
	conv, err := conversation.Open(filepath.Join(t.TempDir(), "conversations.json"))
	if err != nil {
		t.Fatalf("conversation.Open: %v", err)
	}
	srv.d.Conversations = conv
	dir := filepath.Join(srv.d.ProjectsRoot, "proj")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	mgr.subdirCwd = dir
	mgr.listed = []manager.Info{{ID: syncFixtureID, Cwd: dir, State: "ready"}}
	mgr.sessions = map[string]*session.Session{
		syncFixtureID: session.New(syncFixtureID, dir, &testBuffer{}, func(session.Event) {}),
	}
	seedTranscript(t, srv.d.HistoryDir, syncFixtureID, dir)
	return srv, mgr, conv, syncFixtureID
}

// seedTranscript 在 HistoryDir 下种一份最小转录（让 TranscriptExists 成立）。
func seedTranscript(t *testing.T, historyDir, id, cwd string) {
	t.Helper()
	dir := filepath.Join(historyDir, "proj")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	body := `{"type":"user","sessionId":"` + id + `","cwd":"` + cwd + `",` +
		`"timestamp":"2026-01-01T00:00:00Z",` +
		`"message":{"role":"user","content":"已有的一句话"}}` + "\n"
	if err := os.WriteFile(filepath.Join(dir, id+".jsonl"), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

// dispatchPrompt 走一遍真实的 WS 分发路径（不经过 socket）。
func dispatchPrompt(t *testing.T, srv *Server, mgr *fakeMgr, id, text string) {
	t.Helper()
	sess, ok := mgr.Get(id)
	if !ok {
		t.Fatalf("会话 %s 不存在", id)
	}
	c := &wsClient{out: make(chan []byte, 8), done: make(chan struct{})}
	payload, err := json.Marshal(map[string]string{"kind": "prompt", "text": text})
	if err != nil {
		t.Fatal(err)
	}
	srv.dispatch(c, sess, id, payload)
}

func patchConversation(t *testing.T, srv *Server, body map[string]any) {
	t.Helper()
	raw, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodPatch, "/api/conversations", strings.NewReader(string(raw))))
	if rec.Code != http.StatusOK {
		t.Fatalf("PATCH 失败: %d %s", rec.Code, rec.Body.String())
	}
}

// 把一条**已经在列表里、但没有进程**的对话打开（POST /api/session {resume}）：
// 它的 live 从 false 变 true，别的设备上那一行要从「未运行」变「活跃」。
//
// 进程**结束**早就推了（NoteSessionClosed），起来的这一次原来一条都没有——
// 另一半缺口，症状是「另一台设备上点开过的对话还显示未运行，直到随便点一下」。
func TestResumeRevivesConversationBroadcasts(t *testing.T) {
	srv, mgr, _, id := newSyncFixture(t)
	// 先把它从存活会话里摘掉：模拟「进程已被回收」，列表里只剩转录与元数据。
	mgr.listed = nil
	mgr.sessions = nil
	rec := &recClient{}
	srv.d.Hub.Subscribe(systemTopic, rec)

	body := `{"cwd":"` + mgr.cwd() + `","resume":"` + id + `"}`
	resp := httptest.NewRecorder()
	srv.Handler().ServeHTTP(resp, httptest.NewRequest(http.MethodPost, "/api/session", strings.NewReader(body)))
	if resp.Code != http.StatusOK {
		t.Fatalf("code = %d: %s", resp.Code, resp.Body.String())
	}
	if n := len(rec.take()); n != 1 {
		t.Fatalf("进程被拉起应推 1 次 conversations.changed，得到 %d", n)
	}
}

// 已经在跑的对话被再打开一次（切回同一条对话、刷新页面）不该推：列表里那一行
// 什么都没变，而每次推送都让所有连接重扫一遍全部转录。
func TestResumeLiveConversationDoesNotBroadcast(t *testing.T) {
	srv, mgr, _, id := newSyncFixture(t)
	// fixture 里这条会话是存活的（mgr.listed 含它）。
	if _, ok := mgr.Get(id); !ok {
		t.Fatal("fixture 应让这条会话存活")
	}
	rec := &recClient{}
	srv.d.Hub.Subscribe(systemTopic, rec)

	body := `{"cwd":"` + mgr.cwd() + `","resume":"` + id + `"}`
	resp := httptest.NewRecorder()
	srv.Handler().ServeHTTP(resp, httptest.NewRequest(http.MethodPost, "/api/session", strings.NewReader(body)))
	if resp.Code != http.StatusOK {
		t.Fatalf("code = %d: %s", resp.Code, resp.Body.String())
	}
	if events := rec.take(); len(events) != 0 {
		t.Fatalf("已在跑的对话不该推送，得到 %+v", events)
	}
}

// `/clear` 换了会话 id 之后，待通知回合要跟着搬到新 id。
//
// 不搬的话它永远没人消费：回合结束时的事件按新 id 走（session.CurrentID），
// `NoteSessionState(newID)` 在旧 id 下找不到记录，标题补写与列表刷新都不会发生，
// 表里还留下一条永不删除的残项。
func TestSessionReplacedMovesPendingTurn(t *testing.T) {
	srv, _, _, id := newSyncFixture(t)

	srv.watchPendingTurn(id, pendingTurn{title: "每日巡检 · 11-20 09:00", cwd: srv.d.ProjectsRoot})
	srv.NoteSessionReplaced(id, "cleared-id")

	if _, ok := srv.consumePendingTurn(id); ok {
		t.Fatal("旧 id 上不该还留着待通知记录")
	}
	turn, ok := srv.consumePendingTurn("cleared-id")
	if !ok {
		t.Fatal("待通知记录没有搬到新 id")
	}
	if turn.title != "每日巡检 · 11-20 09:00" {
		t.Fatalf("搬过去的记录 = %+v，标题丢了", turn)
	}
	// 搬过一次之后就没有了，不会重复消费。
	if _, ok := srv.consumePendingTurn("cleared-id"); ok {
		t.Fatal("consume 之后不该还在")
	}
}

// 新 id 上已经有一条待通知记录时，保留原来那条（不覆盖）。
func TestSessionReplacedKeepsExistingPendingTurn(t *testing.T) {
	srv, _, _, id := newSyncFixture(t)

	srv.watchPendingTurn(id, pendingTurn{title: "旧的"})
	srv.watchPendingTurn("cleared-id", pendingTurn{title: "新的"})
	srv.NoteSessionReplaced(id, "cleared-id")

	turn, ok := srv.consumePendingTurn("cleared-id")
	if !ok || turn.title != "新的" {
		t.Fatalf("新 id 上原有的记录被覆盖了: %+v (ok=%v)", turn, ok)
	}
}
