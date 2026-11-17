package gateway

import (
	"encoding/json"
	"sync"
	"testing"

	"ccweb/backend/internal/claudebin"
)

// recClient 记录推给它的事件；hub.Broadcast 在调用方 goroutine 上同步调用，
// 因此这里必须加锁（引擎的 -race 会抓）。
type recClient struct {
	mu     sync.Mutex
	events []WireEvent
}

func (c *recClient) SendJSON(v any) error {
	ev, ok := v.(WireEvent)
	if !ok {
		return nil
	}
	c.mu.Lock()
	c.events = append(c.events, ev)
	c.mu.Unlock()
	return nil
}

// take 取走并清空已记录的事件。
func (c *recClient) take() []WireEvent {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := c.events
	c.events = nil
	return out
}

func TestBroadcastClaudeUpdatePushesOncePerVersion(t *testing.T) {
	srv := withDeploy(t, &fakeDeploy{status: claudebin.Status{
		Active:          "2.1.325",
		Latest:          "2.1.326",
		UpdateAvailable: true,
	}})
	rec := &recClient{}
	srv.d.Hub.Subscribe(systemTopic, rec)

	srv.BroadcastClaudeUpdate()
	srv.BroadcastClaudeUpdate() // 同一个最新版本只推一次

	events := rec.take()
	if len(events) != 1 {
		t.Fatalf("推送次数 = %d, want 1（同一最新版本只推一次）", len(events))
	}
	if events[0].Kind != "claude.update" {
		t.Fatalf("事件 kind = %q, want claude.update", events[0].Kind)
	}
	var payload map[string]string
	if err := json.Unmarshal(events[0].Data, &payload); err != nil {
		t.Fatalf("解析推送载荷: %v", err)
	}
	if payload["latest"] != "2.1.326" || payload["active"] != "2.1.325" {
		t.Fatalf("载荷 = %v, want latest 2.1.326 / active 2.1.325", payload)
	}
}

func TestBroadcastClaudeUpdateSkipsWhenCurrent(t *testing.T) {
	upgradable := claudebin.Status{Active: "2.1.325", Latest: "2.1.326", UpdateAvailable: true}
	f := &fakeDeploy{status: upgradable}
	srv := withDeploy(t, f)
	rec := &recClient{}
	srv.d.Hub.Subscribe(systemTopic, rec)

	srv.BroadcastClaudeUpdate()
	if n := len(rec.take()); n != 1 {
		t.Fatalf("首次推送 = %d 次, want 1", n)
	}

	// 用户装上之后不再有更新：这一轮不推，但要清掉去重标记，
	// 否则同一个版本号以后再出现（回滚到旧版本）就永远推不出去。
	f.status = claudebin.Status{Active: "2.1.326", Latest: "2.1.326"}
	srv.BroadcastClaudeUpdate()
	if n := len(rec.take()); n != 0 {
		t.Fatalf("已是最新时推送 = %d 次, want 0", n)
	}

	f.status = upgradable
	srv.BroadcastClaudeUpdate()
	if n := len(rec.take()); n != 1 {
		t.Fatalf("回滚后同版本号的推送 = %d 次, want 1（去重标记没清掉）", n)
	}
}

func TestBroadcastClaudeUpdateWithoutDeployer(t *testing.T) {
	srv, _ := newTestServer(t, "secret") // Deps.Claude 为 nil
	srv.BroadcastClaudeUpdate()          // 不能 panic
}
