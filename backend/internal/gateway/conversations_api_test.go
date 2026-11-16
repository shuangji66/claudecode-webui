package gateway

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

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
}
