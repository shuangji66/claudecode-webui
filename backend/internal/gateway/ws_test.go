package gateway

import (
	"bufio"
	"io"
	"net"
	"testing"
	"time"
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
