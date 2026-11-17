package gateway

import (
	"bufio"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"ccweb/backend/internal/claudebin"
	"ccweb/backend/internal/wsframe"
)

// 回归：写失败已经把 closed 置位时，close() 仍必须释放 socket。
//
// 旧实现的 close() 用 `if c.closed.Swap(true) { return }` 早退，于是「先写失败、
// 后清理」这条路径上 conn.Close() 永远不会执行。hijack 出来的连接不归
// net/http 管，没人关就永久占着 fd，长期运行会把进程的 fd 耗光。
func TestWSClientCloseAfterWriteFailureReleasesConn(t *testing.T) {
	srv, peer := net.Pipe()
	t.Cleanup(func() { _ = peer.Close() })

	c := newWSClient(srv, bufio.NewReader(srv), "")
	// 模拟写循环写失败后的状态：closed 已置位，socket 还没关。
	c.closed.Store(true)

	c.close()

	// 对端应当立刻看到 EOF：socket 真的被关掉了。
	_ = peer.SetReadDeadline(time.Now().Add(2 * time.Second))
	if _, err := peer.Read(make([]byte, 1)); err != io.EOF {
		t.Fatalf("关闭后对端读到的错误 = %v, want io.EOF（socket 没有被关闭）", err)
	}
}

// close() 可以重复调用，且第二次不应向已关闭的连接再写 close 帧。
func TestWSClientCloseIsIdempotent(t *testing.T) {
	srv, peer := net.Pipe()
	t.Cleanup(func() { _ = peer.Close() })

	c := newWSClient(srv, bufio.NewReader(srv), "")
	// net.Pipe 无缓冲：close 帧的写会阻塞到对端读，所以放在 goroutine 里。
	done := make(chan struct{})
	go func() {
		c.close()
		c.close()
		close(done)
	}()

	_ = peer.SetReadDeadline(time.Now().Add(2 * time.Second))
	buf, err := io.ReadAll(peer)
	if err != nil {
		t.Fatalf("读对端失败: %v", err)
	}
	<-done
	if len(buf) == 0 {
		t.Fatal("没有收到 close 帧")
	}
}

// Broadcast 跑在 session 的读循环 goroutine 上，SendJSON 绝不能碰网络。
// 一个不读数据的客户端只应拖慢它自己：队列满时立刻返回错误，由 hub 退订。
func TestWSClientSendJSONNeverBlocksOnSlowClient(t *testing.T) {
	srv, peer := net.Pipe()
	t.Cleanup(func() { _ = peer.Close() })
	c := newWSClient(srv, bufio.NewReader(srv), "topic")
	t.Cleanup(c.close)

	var lastErr error
	for i := 0; i < sendQueueLen+8; i++ {
		begin := time.Now()
		lastErr = c.SendJSON(map[string]int{"seq": i})
		if cost := time.Since(begin); cost > 200*time.Millisecond {
			t.Fatalf("第 %d 次 SendJSON 阻塞了 %v", i, cost)
		}
		if lastErr != nil {
			break
		}
	}
	if lastErr == nil {
		t.Fatalf("发送队列（%d）填满后仍返回成功", sendQueueLen)
	}
}

// dialWS 用裸 TCP 完成一次 RFC 6455 握手，返回连接与后续帧的读取器。
// gateway 的 WS 是手写的（internal/wsframe），测试里也得按帧收发。
func dialWS(t *testing.T, addr, path string) (net.Conn, *bufio.Reader) {
	t.Helper()
	conn, err := net.Dial("tcp", addr)
	if err != nil {
		t.Fatalf("拨号 %s: %v", addr, err)
	}
	req := "GET " + path + " HTTP/1.1\r\n" +
		"Host: ccweb.test\r\n" +
		"Upgrade: websocket\r\n" +
		"Connection: Upgrade\r\n" +
		"Sec-WebSocket-Key: AAAAAAAAAAAAAAAAAAAAAA==\r\n" +
		"Sec-WebSocket-Version: 13\r\n\r\n"
	if _, err := conn.Write([]byte(req)); err != nil {
		t.Fatalf("写握手: %v", err)
	}
	r := bufio.NewReader(conn)
	line, err := r.ReadString('\n')
	if err != nil {
		t.Fatalf("读状态行: %v", err)
	}
	if !strings.Contains(line, "101") {
		t.Fatalf("握手状态 = %q, want 101", strings.TrimSpace(line))
	}
	for {
		line, err := r.ReadString('\n')
		if err != nil {
			t.Fatalf("读响应头: %v", err)
		}
		if line == "\r\n" {
			break
		}
	}
	return conn, r
}

// waitSubscribers 等 handler 完成订阅（握手成功与 hub.Subscribe 之间还有几条语句）。
func waitSubscribers(t *testing.T, srv *Server, topic string, want int) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if srv.d.Hub.Count(topic) == want {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("topic %q 的订阅者 = %d, want %d", topic, srv.d.Hub.Count(topic), want)
}

// 不带 id 的 /ws 是系统通道：没有会话也要能连上，并收到应用级广播。
func TestWSWithoutIDIsSystemChannel(t *testing.T) {
	srv := withDeploy(t, &fakeDeploy{status: claudebin.Status{
		Active:          "2.1.325",
		Latest:          "2.1.326",
		UpdateAvailable: true,
	}})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	conn, r := dialWS(t, ts.Listener.Addr().String(), "/ws?token=secret")
	defer conn.Close()
	waitSubscribers(t, srv, systemTopic, 1)

	srv.BroadcastClaudeUpdate()
	_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	op, payload, err := wsframe.ReadMessage(r, wsframe.DefaultMaxMessageBytes)
	if err != nil {
		t.Fatalf("读帧: %v", err)
	}
	if op != wsframe.OpText {
		t.Fatalf("opcode = %d, want text", op)
	}
	var ev WireEvent
	if err := json.Unmarshal(payload, &ev); err != nil {
		t.Fatalf("解析事件: %v", err)
	}
	if ev.Kind != "claude.update" {
		t.Fatalf("事件 kind = %q, want claude.update", ev.Kind)
	}

	// 系统通道没有会话：命令必须换回一条 error，而不是落到 nil 会话上 panic。
	if _, err := conn.Write(wsframe.Encode(wsframe.OpText, []byte(`{"kind":"prompt","text":"hi"}`))); err != nil {
		t.Fatalf("写命令: %v", err)
	}
	_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	if _, payload, err = wsframe.ReadMessage(r, wsframe.DefaultMaxMessageBytes); err != nil {
		t.Fatalf("读命令回包: %v", err)
	}
	var reply WireEvent
	if err := json.Unmarshal(payload, &reply); err != nil {
		t.Fatalf("解析命令回包: %v", err)
	}
	if reply.Kind != "error" {
		t.Fatalf("系统通道上的 prompt 回包 kind = %q, want error", reply.Kind)
	}
}

// 系统通道同样要过鉴权；带 id 时仍要求会话真实存在。
func TestWSRejectsMissingTokenAndUnknownSession(t *testing.T) {
	srv := withDeploy(t, &fakeDeploy{})

	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/ws", nil))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("无 token 的系统通道 = %d, want 401", rec.Code)
	}

	rec = httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/ws?id=missing&token=secret", nil))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("不存在的会话 id = %d, want 404", rec.Code)
	}
}
