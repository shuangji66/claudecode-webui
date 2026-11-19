package gateway

import (
	"bufio"
	"encoding/json"
	"net"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"ccweb/backend/internal/wsframe"
)

func gitCmd(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
	cmd.Env = append(os.Environ(), "LC_ALL=C", "GIT_TERMINAL_PROMPT=0")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
}

func writeCmd(t *testing.T, conn net.Conn, v any) {
	t.Helper()
	payload, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("编码命令: %v", err)
	}
	if _, err := conn.Write(wsframe.Encode(wsframe.OpText, payload)); err != nil {
		t.Fatalf("写命令: %v", err)
	}
}

// readEvent 读一帧并解析成 WireEvent；读超时由调用方在 conn 上设。
func readEvent(t *testing.T, r *bufio.Reader) WireEvent {
	t.Helper()
	_, payload, err := wsframe.ReadMessage(r, wsframe.DefaultMaxMessageBytes)
	if err != nil {
		t.Fatalf("读帧: %v", err)
	}
	var ev WireEvent
	if err := json.Unmarshal(payload, &ev); err != nil {
		t.Fatalf("解析事件 %s: %v", payload, err)
	}
	return ev
}

// 系统通道上的 Git 订阅：授权目录里的仓库一改就推 git.changed；
// 授权目录外的 cwd 只回 error（不能凭一条命令盯任意路径）。
func TestSystemChannelGitWatchPushesChanges(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("没有 git")
	}
	srv, _ := newTestServer(t, "secret")
	prev := gitWatchInterval
	gitWatchInterval = 20 * time.Millisecond
	t.Cleanup(func() { gitWatchInterval = prev })

	repo := filepath.Join(srv.d.ProjectsRoot, "repo")
	if err := os.MkdirAll(repo, 0o755); err != nil {
		t.Fatalf("建目录: %v", err)
	}
	gitCmd(t, repo, "init", "-q")
	gitCmd(t, repo, "config", "user.email", "t@example.com")
	gitCmd(t, repo, "config", "user.name", "T")
	file := filepath.Join(repo, "a.txt")
	if err := os.WriteFile(file, []byte("one\n"), 0o600); err != nil {
		t.Fatalf("写文件: %v", err)
	}
	gitCmd(t, repo, "add", ".")
	gitCmd(t, repo, "commit", "-qm", "init")

	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()
	conn, r := dialWS(t, ts.Listener.Addr().String(), "/ws?token=secret")
	defer conn.Close()
	waitSubscribers(t, srv, systemTopic, 1)

	// 工作区之外的路径：必须被拒，而不是默默开始每几秒跑一次 git。
	writeCmd(t, conn, map[string]string{"kind": "git.watch", "cwd": t.TempDir()})
	_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	if ev := readEvent(t, r); ev.Kind != "error" {
		t.Fatalf("未授权 cwd 的 git.watch 回包 kind = %q, want error", ev.Kind)
	}

	writeCmd(t, conn, map[string]string{"kind": "git.watch", "cwd": repo})
	// 等第一轮基线建立（watch 先读一次再比对，基线那一轮不推）。
	time.Sleep(200 * time.Millisecond)

	if err := os.WriteFile(file, []byte("two\n"), 0o600); err != nil {
		t.Fatalf("改文件: %v", err)
	}
	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	ev := readEvent(t, r)
	if ev.Kind != "git.changed" {
		t.Fatalf("改动后事件 kind = %q, want git.changed", ev.Kind)
	}
	var data struct {
		Cwd string `json:"cwd"`
	}
	if err := json.Unmarshal(ev.Data, &data); err != nil {
		t.Fatalf("解析 data: %v", err)
	}
	if data.Cwd != repo {
		t.Fatalf("推送的 cwd = %q, want %q", data.Cwd, repo)
	}
}
