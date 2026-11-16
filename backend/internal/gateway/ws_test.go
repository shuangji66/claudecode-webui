package gateway

import (
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

	c := &wsClient{conn: srv}
	// 模拟 writeFrame 写失败后的状态：closed 已置位，socket 还没关。
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

	c := &wsClient{conn: srv}
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
