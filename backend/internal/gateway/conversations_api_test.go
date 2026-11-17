package gateway

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"ccweb/backend/internal/conversation"
)

func withConversationStore(t *testing.T, srv *Server) *conversation.Store {
	t.Helper()
	store, err := conversation.Open(filepath.Join(t.TempDir(), "conversations.json"))
	if err != nil {
		t.Fatal(err)
	}
	srv.d.Conversations = store
	return store
}

func writeTranscript(t *testing.T, root, id, cwd string) {
	t.Helper()
	path := filepath.Join(root, "-tmp-work", id+".jsonl")
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	lines := []string{
		`{"type":"user","cwd":"` + cwd + `","sessionId":"` + id + `","timestamp":"2026-11-16T01:00:00Z","message":{"role":"user","content":"第一条消息"}}`,
		`{"type":"assistant","sessionId":"` + id + `","timestamp":"2026-11-16T01:01:00Z","message":{"role":"assistant","content":[{"type":"text","text":"收到"}]}}`,
	}
	if err := os.WriteFile(path, []byte(strings.Join(lines, "\n")+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestConversationsListPatchDelete(t *testing.T) {
	srv, _ := newTestServer(t, "")
	store := withConversationStore(t, srv)
	root := srv.d.ProjectsRoot
	id := "11111111-2222-4333-8444-555555555555"
	writeTranscript(t, srv.d.HistoryDir, id, root)

	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/conversations", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("code = %d: %s", rec.Code, rec.Body.String())
	}
	var body struct {
		Conversations []struct {
			ID       string `json:"id"`
			Cwd      string `json:"cwd"`
			Title    string `json:"title"`
			Messages int    `json:"messages"`
			Archived bool   `json:"archived"`
		} `json:"conversations"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	var got *struct {
		ID       string `json:"id"`
		Cwd      string `json:"cwd"`
		Title    string `json:"title"`
		Messages int    `json:"messages"`
		Archived bool   `json:"archived"`
	}
	for i := range body.Conversations {
		if body.Conversations[i].ID == id {
			got = &body.Conversations[i]
		}
	}
	if got == nil || got.Title != "第一条消息" || got.Messages != 2 || got.Cwd != root {
		t.Fatalf("conversation = %+v", body.Conversations)
	}

	// 重命名 + 归档
	patch := `{"id":"` + id + `","title":"  自定义  ","archived":true}`
	rec = httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodPatch, "/api/conversations", strings.NewReader(patch)))
	if rec.Code != http.StatusOK {
		t.Fatalf("patch code = %d: %s", rec.Code, rec.Body.String())
	}
	rec2, _ := store.Get(id)
	if rec2.Title != "自定义" || !rec2.Archived {
		t.Fatalf("record = %+v", rec2)
	}

	// 转录回放
	rec = httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/history/transcript?id="+id, nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("transcript code = %d: %s", rec.Code, rec.Body.String())
	}
	var transcript struct {
		ID    string            `json:"id"`
		Lines []json.RawMessage `json:"lines"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &transcript); err != nil {
		t.Fatal(err)
	}
	if transcript.ID != id || len(transcript.Lines) != 2 {
		t.Fatalf("transcript = %+v", transcript)
	}

	// 删除后列表不再出现
	rec = httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodDelete, "/api/conversations?id="+id, nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("delete code = %d: %s", rec.Code, rec.Body.String())
	}
	rec = httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/conversations", nil))
	_ = json.Unmarshal(rec.Body.Bytes(), &body)
	for _, c := range body.Conversations {
		if c.ID == id {
			t.Fatal("删除后仍出现在列表里")
		}
	}
}

func TestConversationPinned(t *testing.T) {
	srv, _ := newTestServer(t, "")
	store := withConversationStore(t, srv)
	id := "22222222-3333-4444-8555-666666666666"
	writeTranscript(t, srv.d.HistoryDir, id, srv.d.ProjectsRoot)

	// 置顶走 PATCH，落到 conversations.json。
	body := `{"id":"` + id + `","pinned":true}`
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodPatch, "/api/conversations", strings.NewReader(body)))
	if rec.Code != http.StatusOK {
		t.Fatalf("patch code = %d: %s", rec.Code, rec.Body.String())
	}
	if got, _ := store.Get(id); !got.Pinned {
		t.Fatalf("置顶没存下来: %+v", got)
	}

	// 列表必须把 pinned 带出去：前端靠它排序，缺了就永远排不到最前。
	rec = httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/conversations", nil))
	var list struct {
		Conversations []struct {
			ID     string `json:"id"`
			Pinned bool   `json:"pinned"`
		} `json:"conversations"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &list); err != nil {
		t.Fatal(err)
	}
	seen := false
	for _, c := range list.Conversations {
		if c.ID == id {
			if !c.Pinned {
				t.Fatal("列表里的 pinned 丢了")
			}
			seen = true
		}
	}
	if !seen {
		t.Fatalf("置顶对话不在列表里: %+v", list.Conversations)
	}

	// 取消置顶
	body = `{"id":"` + id + `","pinned":false}`
	rec = httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodPatch, "/api/conversations", strings.NewReader(body)))
	if rec.Code != http.StatusOK {
		t.Fatalf("unpin code = %d: %s", rec.Code, rec.Body.String())
	}
	if got, _ := store.Get(id); got.Pinned {
		t.Fatal("取消置顶没生效")
	}
}

func TestForkConversation(t *testing.T) {
	srv, _ := newTestServer(t, "")
	store := withConversationStore(t, srv)
	root := srv.d.ProjectsRoot
	oldID := "33333333-4444-4555-8666-777777777777"
	writeTranscript(t, srv.d.HistoryDir, oldID, root)
	forkID := "22222222-3333-4444-8555-666666666677"
	// fakeMgr 返回固定的 fork id；预写转录，让 handler 的等待立刻返回。
	writeTranscript(t, srv.d.HistoryDir, forkID, root)

	body := `{"id":"` + oldID + `","title":"旧会话（分叉）"}`
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/conversations/fork", strings.NewReader(body)))
	if rec.Code != http.StatusOK {
		t.Fatalf("fork code = %d: %s", rec.Code, rec.Body.String())
	}
	var out struct {
		ID  string `json:"id"`
		Cwd string `json:"cwd"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if out.ID != forkID || out.Cwd != root {
		t.Fatalf("fork 返回 = %+v", out)
	}
	if fm := srv.d.Manager.(*fakeMgr); len(fm.forked) != 1 || fm.forked[0] != oldID {
		t.Fatalf("manager.Fork 的参数 = %v", fm.forked)
	}
	// 新会话要立刻出现在列表里（转录可能还没写完，靠元数据兜底）。
	rec = httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/conversations", nil))
	var list struct {
		Conversations []struct {
			ID    string `json:"id"`
			Title string `json:"title"`
		} `json:"conversations"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &list); err != nil {
		t.Fatal(err)
	}
	found := false
	for _, c := range list.Conversations {
		if c.ID == forkID {
			found = true
			if c.Title != "旧会话（分叉）" {
				t.Fatalf("分叉标题 = %q", c.Title)
			}
		}
	}
	if !found {
		t.Fatalf("分叉出来的对话不在列表里: %+v", list.Conversations)
	}
	if got, _ := store.Get(forkID); got.Cwd != root || got.Title != "旧会话（分叉）" {
		t.Fatalf("分叉元数据 = %+v", got)
	}

	// 不存在的原对话
	rec = httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/conversations/fork", strings.NewReader(`{"id":"unknown"}`)))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("未知对话应 404，实际 %d", rec.Code)
	}
}

// fork 的三类失败必须挡在起进程之前：没有转录（CLI 必然 --resume 失败）、
// 已删除、会话池已满。起进程之后再报错会留下一条永远 resume 不了的元数据。
func TestForkConversationRejectsBadSource(t *testing.T) {
	srv, _ := newTestServer(t, "")
	store := withConversationStore(t, srv)
	root := srv.d.ProjectsRoot
	fm := srv.d.Manager.(*fakeMgr)

	post := func(id string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/conversations/fork", strings.NewReader(`{"id":"`+id+`"}`)))
		return rec
	}

	// 0) 标题超长：起进程之前就拒绝，否则 fork 成了绕过 120 字上限的后门。
	longTitleID := "77777777-8888-4999-8aaa-bbbbbbbbbbbb"
	writeTranscript(t, srv.d.HistoryDir, longTitleID, root)
	rec := httptest.NewRecorder()
	longBody := `{"id":"` + longTitleID + `","title":"` + strings.Repeat("字", 121) + `"}`
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/conversations/fork", strings.NewReader(longBody)))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("标题超长应 400，实际 %d: %s", rec.Code, rec.Body.String())
	}

	// 1) 空对话：有元数据、没有转录。
	emptyID := "44444444-5555-4666-8777-888888888888"
	if err := store.Touch(emptyID, root); err != nil {
		t.Fatal(err)
	}
	if rec := post(emptyID); rec.Code != http.StatusBadRequest {
		t.Fatalf("没有转录应 400，实际 %d: %s", rec.Code, rec.Body.String())
	}

	// 2) 已删除的对话。
	deletedID := "55555555-6666-4777-8888-999999999999"
	writeTranscript(t, srv.d.HistoryDir, deletedID, root)
	if err := store.Touch(deletedID, root); err != nil {
		t.Fatal(err)
	}
	if err := store.Delete(deletedID); err != nil {
		t.Fatal(err)
	}
	if rec := post(deletedID); rec.Code != http.StatusConflict {
		t.Fatalf("已删除应 409，实际 %d: %s", rec.Code, rec.Body.String())
	}

	// 3) 会话池满：manager 的错误是「当前状态冲突」，不是 500。
	fullID := "66666666-7777-4888-8999-aaaaaaaaaaaa"
	writeTranscript(t, srv.d.HistoryDir, fullID, root)
	fm.failOn = "fork"
	if rec := post(fullID); rec.Code != http.StatusConflict {
		t.Fatalf("manager 报错应 409，实际 %d: %s", rec.Code, rec.Body.String())
	}
	// 失败之后不能留下任何新元数据。
	if len(fm.forked) != 0 {
		t.Fatalf("起进程前就该拦住: %v", fm.forked)
	}
}

func TestConversationsRequireAuthAndRejectBadTranscriptID(t *testing.T) {
	srv, _ := newTestServer(t, "secret")
	withConversationStore(t, srv)
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/conversations", nil))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("无 token 应 401，实际 %d", rec.Code)
	}

	req := httptest.NewRequest(http.MethodGet, "/api/history/transcript?id=../../etc/passwd", nil)
	req.Header.Set("Authorization", "Bearer secret")
	rec = httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("非法 id 应 404，实际 %d: %s", rec.Code, rec.Body.String())
	}
}

func TestResumeConversationUsesStableID(t *testing.T) {
	srv, mgr := newTestServer(t, "")
	store := withConversationStore(t, srv)
	root := srv.d.ProjectsRoot
	id := "33333333-4444-4555-8666-777777777777"
	if err := store.Touch(id, root); err != nil {
		t.Fatal(err)
	}
	body := `{"cwd":"` + root + `","resume":"` + id + `"}`
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/session", strings.NewReader(body)))
	if rec.Code != http.StatusOK {
		t.Fatalf("code = %d: %s", rec.Code, rec.Body.String())
	}
	var info struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &info)
	if info.ID != id {
		t.Fatalf("resume 返回 id = %q", info.ID)
	}
	if len(mgr.resumed) != 1 || mgr.resumed[0] != id {
		t.Fatalf("resumed = %v", mgr.resumed)
	}
	if rec, _ := store.Get(id); rec.LastActive.IsZero() {
		t.Fatal("resume 应刷新 last_active")
	}

	// 已删除的对话不能被 resume 复活。
	if err := store.Delete(id); err != nil {
		t.Fatal(err)
	}
	rec = httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/session", strings.NewReader(body)))
	if rec.Code != http.StatusConflict {
		t.Fatalf("已删除对话应 409，实际 %d: %s", rec.Code, rec.Body.String())
	}
}

// 回归：PATCH 里 usage 非法时要整条请求失败，且前面的字段不能被改掉。
//
// 旧顺序是「重命名（写盘）→ 归档（写盘）→ usage 校验」，usage 不合法返回 400 时
// 标题早就改完了，前端把整次请求当失败，界面与服务端状态不一致。
func TestPatchConversationValidatesBeforeWriting(t *testing.T) {
	srv, _ := newTestServer(t, "")
	store := withConversationStore(t, srv)
	writeTranscript(t, srv.d.HistoryDir, "11111111-2222-3333-4444-555555555555", srv.d.ProjectsRoot)

	// 先落一条元数据。
	if err := store.Touch("11111111-2222-3333-4444-555555555555", srv.d.ProjectsRoot); err != nil {
		t.Fatal(err)
	}

	usage := `{"input_tokens":` + strings.Repeat("9", 3000) + `}`
	body := `{"id":"11111111-2222-3333-4444-555555555555","title":"新标题","usage":` + usage + `}`
	req := httptest.NewRequest(http.MethodPatch, "/api/conversations", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec2 := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec2, req)
	if rec2.Code != http.StatusBadRequest {
		t.Fatalf("超长 usage 应 400，实际 %d: %s", rec2.Code, rec2.Body.String())
	}
	got, ok := store.Get("11111111-2222-3333-4444-555555555555")
	if !ok {
		t.Fatal("对话记录丢失")
	}
	if got.Title != "" {
		t.Fatalf("请求失败但标题被改了: %q", got.Title)
	}

	// 反过来也一样：标题超长时那次 usage 不能已经落盘（两处校验都在写盘之前）。
	body = `{"id":"11111111-2222-3333-4444-555555555555","title":"` + strings.Repeat("字", maxTitleRunes+1) + `","usage":{"input_tokens":1}}`
	rec2 = httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec2, httptest.NewRequest(http.MethodPatch, "/api/conversations", strings.NewReader(body)))
	if rec2.Code != http.StatusBadRequest {
		t.Fatalf("超长标题应 400，实际 %d: %s", rec2.Code, rec2.Body.String())
	}
	if got, _ := store.Get("11111111-2222-3333-4444-555555555555"); len(got.Usage) != 0 {
		t.Fatalf("标题被拒时 usage 却写进去了: %s", got.Usage)
	}
}

// 标题规则只有一份：重命名与分叉共用，否则两边会各自漂移。
func TestNormalizeTitle(t *testing.T) {
	cases := []struct {
		name    string
		in      string
		want    string
		wantErr bool
	}{
		{"折叠多余空白", "  会话   甲\n", "会话 甲", false},
		{"刚好上限", strings.Repeat("字", maxTitleRunes), strings.Repeat("字", maxTitleRunes), false},
		{"超过上限", strings.Repeat("字", maxTitleRunes+1), "", true},
		{"全空白等于清空", "   ", "", false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, err := normalizeTitle(c.in)
			if c.wantErr {
				if err == nil {
					t.Fatalf("应报错，得到 %q", got)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got != c.want {
				t.Fatalf("normalizeTitle = %q, want %q", got, c.want)
			}
		})
	}
}

// fork 之后只等旧转录所在目录里的新文件：出现就立刻返回，不等满超时。
func TestWaitForkTranscript(t *testing.T) {
	srv, _ := newTestServer(t, "")
	oldID := "88888888-9999-4aaa-8bbb-cccccccccccc"
	newID := "99999999-aaaa-4bbb-8ccc-dddddddddddd"
	writeTranscript(t, srv.d.HistoryDir, oldID, srv.d.ProjectsRoot)

	// 旧转录都找不到时不必等：fork 读不到历史，也就没什么可等的。
	started := time.Now()
	srv.waitForkTranscript("aaaaaaaa-1111-4222-8333-444444444444", newID)
	if elapsed := time.Since(started); elapsed > 500*time.Millisecond {
		t.Fatalf("没有旧转录时不该干等: %v", elapsed)
	}

	writeTranscript(t, srv.d.HistoryDir, newID, srv.d.ProjectsRoot)
	started = time.Now()
	srv.waitForkTranscript(oldID, newID)
	if elapsed := time.Since(started); elapsed > time.Second {
		t.Fatalf("转录已存在时应立刻返回: %v", elapsed)
	}

	// 超时上限被调成 0 时只探一次就放弃（测试与降级路径都靠这个开关）。
	defer func(d time.Duration) { forkTranscriptWait = d }(forkTranscriptWait)
	forkTranscriptWait = 0
	started = time.Now()
	srv.waitForkTranscript(oldID, "bbbbbbbb-2222-4333-8444-555555555555")
	if elapsed := time.Since(started); elapsed > 500*time.Millisecond {
		t.Fatalf("上限为 0 时不该继续轮询: %v", elapsed)
	}
}
