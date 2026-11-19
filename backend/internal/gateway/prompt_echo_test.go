package gateway

import (
	"encoding/json"
	"testing"

	"ccweb/backend/internal/agent/session"
	"ccweb/backend/internal/hub"
)

// prompt.echo：别的设备发的提示词必须补到本机。
//
// 用户气泡是本地乐观插入的，CLI 又不回显 stdin 里的消息（没开
// --replay-user-messages）：不广播的话，另一台设备上只剩模型突然开始思考，
// 用户刚发的那句话凭空消失。
func TestPromptEchoBroadcastsToSessionTopic(t *testing.T) {
	srv, mgr := newTestServer(t, "")
	out := &testBuffer{}
	mgr.sessions = map[string]*session.Session{
		"s1": session.New("s1", mgr.cwd(), out, func(session.Event) {}),
	}
	sess, _ := mgr.Get("s1")

	sub := &fakeHubClient{}
	srv.d.Hub.Subscribe("s1", sub)

	srv.dispatch(&wsClient{out: make(chan []byte, 8), done: make(chan struct{})}, sess, "s1", []byte(`{
		"kind":"prompt",
		"text":"跑一遍测试",
		"attachments":[{"name":"a.log","media_type":"text/plain","data":"aGk="}]
	}`))

	var echo *WireEvent
	for _, ev := range sub.events {
		if ev.Kind == "prompt.echo" {
			got := ev
			echo = &got
		}
	}
	if echo == nil {
		t.Fatalf("没有广播 prompt.echo，收到 %+v", sub.events)
	}
	if echo.SID != "s1" {
		t.Fatalf("sid = %q，want s1", echo.SID)
	}
	var payload promptEcho
	if err := json.Unmarshal(echo.Data, &payload); err != nil {
		t.Fatalf("解析载荷: %v", err)
	}
	if payload.Text != "跑一遍测试" {
		t.Fatalf("text = %q", payload.Text)
	}
	if len(payload.Files) != 1 || payload.Files[0] != "a.log" {
		t.Fatalf("files = %v", payload.Files)
	}
}

// 写 stdin 失败（会话已关闭）时不能广播：消息根本没发出去，
// 补上去会让别的设备以为发出去了。
func TestPromptEchoSkippedWhenPromptFails(t *testing.T) {
	srv, mgr := newTestServer(t, "")
	out := &testBuffer{}
	s := session.New("s1", mgr.cwd(), out, func(session.Event) {})
	_ = s.Close()
	mgr.sessions = map[string]*session.Session{"s1": s}
	sess, _ := mgr.Get("s1")

	sub := &fakeHubClient{}
	srv.d.Hub.Subscribe("s1", sub)

	c := &wsClient{out: make(chan []byte, 8), done: make(chan struct{})}
	srv.dispatch(c, sess, "s1", []byte(`{"kind":"prompt","text":"hi"}`))

	for _, ev := range sub.events {
		if ev.Kind == "prompt.echo" {
			t.Fatal("发送失败时不应广播 prompt.echo")
		}
	}
}

// fakeHubClient 只记录广播出去的事件。
type fakeHubClient struct {
	events []WireEvent
}

func (f *fakeHubClient) SendJSON(v any) error {
	if ev, ok := v.(WireEvent); ok {
		f.events = append(f.events, ev)
	}
	return nil
}

// testBuffer 是会话 Transport 的哑实现：只吞掉写进来的帧。
type testBuffer struct{ data []byte }

func (b *testBuffer) Read(p []byte) (int, error)  { return 0, nil }
func (b *testBuffer) Write(p []byte) (int, error) { b.data = append(b.data, p...); return len(p), nil }
func (b *testBuffer) Close() error                { return nil }

var _ hub.Client = (*fakeHubClient)(nil)
