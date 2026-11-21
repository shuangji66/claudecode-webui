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

// 分栏后两栏各有一个 Git 面板，可能看着不同仓库：一条连接要能同时盯多个仓库，
// 且退订其中一个不能把另一个也停掉。
func TestSystemChannelGitWatchMultipleRepos(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("没有 git")
	}
	srv, _ := newTestServer(t, "secret")
	prev := gitWatchInterval
	gitWatchInterval = 100 * time.Millisecond
	t.Cleanup(func() { gitWatchInterval = prev })

	mkRepo := func(name string) (string, string) {
		dir := filepath.Join(srv.d.ProjectsRoot, name)
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatalf("建目录: %v", err)
		}
		gitCmd(t, dir, "init", "-q")
		gitCmd(t, dir, "config", "user.email", "t@example.com")
		gitCmd(t, dir, "config", "user.name", "T")
		file := filepath.Join(dir, "a.txt")
		if err := os.WriteFile(file, []byte("one\n"), 0o600); err != nil {
			t.Fatalf("写文件: %v", err)
		}
		gitCmd(t, dir, "add", ".")
		gitCmd(t, dir, "commit", "-qm", "init")
		return dir, file
	}
	repoA, fileA := mkRepo("repo-a")
	repoB, fileB := mkRepo("repo-b")

	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()
	conn, r := dialWS(t, ts.Listener.Addr().String(), "/ws?token=secret")
	defer conn.Close()
	waitSubscribers(t, srv, systemTopic, 1)

	writeCmd(t, conn, map[string]string{"kind": "git.watch", "cwd": repoA})
	writeCmd(t, conn, map[string]string{"kind": "git.watch", "cwd": repoB})
	// 两个观察者同时在跑 git status，冷启动的第一轮可能比单仓库慢：多等一会儿
	// 让基线稳定建立，否则「改文件」可能正好落在第一轮之前，被当成基线的一部分。
	time.Sleep(1500 * time.Millisecond)

	changedCwd := func() string {
		_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
		ev := readEvent(t, r)
		if ev.Kind != "git.changed" {
			t.Fatalf("事件 kind = %q, want git.changed", ev.Kind)
		}
		var data struct {
			Cwd string `json:"cwd"`
		}
		if err := json.Unmarshal(ev.Data, &data); err != nil {
			t.Fatalf("解析 data: %v", err)
		}
		return data.Cwd
	}

	// 注意：Watch 的快照键是「路径 + XY + numstat」，同样行数的改写不会推送。
	// 测试里的两次改动都刻意改变行数（加一行），否则第二轮没有推送可等。
	if err := os.WriteFile(fileB, []byte("one\nb\n"), 0o600); err != nil {
		t.Fatalf("改 B: %v", err)
	}
	if got := changedCwd(); got != repoB {
		t.Fatalf("B 的推送 cwd = %q, want %q", got, repoB)
	}
	if err := os.WriteFile(fileA, []byte("one\na\n"), 0o600); err != nil {
		t.Fatalf("改 A: %v", err)
	}
	if got := changedCwd(); got != repoA {
		t.Fatalf("A 的推送 cwd = %q, want %q", got, repoA)
	}

	// 退订 A（带 cwd，只退它）：A 再变不该有推送，B 的观察者仍然活着。
	writeCmd(t, conn, map[string]string{"kind": "git.unwatch", "cwd": repoA})
	time.Sleep(100 * time.Millisecond)
	if err := os.WriteFile(fileA, []byte("one\na\nb\n"), 0o600); err != nil {
		t.Fatalf("再改 A: %v", err)
	}
	if err := os.WriteFile(fileB, []byte("one\nb\nc\n"), 0o600); err != nil {
		t.Fatalf("再改 B: %v", err)
	}
	// 两处都改了：下一条推送必须是 B。A 的观察者若没退掉，这里会先收到 A。
	if got := changedCwd(); got != repoB {
		t.Fatalf("退订 A 之后的第一条推送 cwd = %q, want %q", got, repoB)
	}

	// 再给 B 一次改动确认观察者还活着；最后才做「不该有推送」的负向检查，
	// 客户端读超时不该影响后续读取。
	if err := os.WriteFile(fileB, []byte("one\nb\nc\nd\n"), 0o600); err != nil {
		t.Fatalf("再改 B: %v", err)
	}
	if got := changedCwd(); got != repoB {
		t.Fatalf("B 的第二次推送 cwd = %q, want %q", got, repoB)
	}
	writeCmd(t, conn, map[string]string{"kind": "git.unwatch", "cwd": repoB})
	time.Sleep(100 * time.Millisecond)
	if err := os.WriteFile(fileB, []byte("one\nb\nc\nd\ne\n"), 0o600); err != nil {
		t.Fatalf("最后改 B: %v", err)
	}
	_ = conn.SetReadDeadline(time.Now().Add(400 * time.Millisecond))
	if _, _, err := wsframe.ReadMessage(r, wsframe.DefaultMaxMessageBytes); err == nil {
		t.Fatal("全部退订后不该再有推送")
	}
}

// 工作区是软链接时，git.watch 与 git.unwatch 必须用同一个键：
// 订阅存的是 realpath，退订却拿原始字符串去删的话永远删不掉，监督协程会一直在
// 「没人看」的时候每 3 秒跑一次 git；推送里的 cwd 也得是客户端认得的写法，
// 否则面板按自己那份路径比对不上，状态永远不自动刷新。
func TestGitWatchSymlinkedPath(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("没有 git")
	}
	srv, _ := newTestServer(t, "secret")
	prev := gitWatchInterval
	gitWatchInterval = 20 * time.Millisecond
	t.Cleanup(func() { gitWatchInterval = prev })

	repo := filepath.Join(srv.d.ProjectsRoot, "real-repo")
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

	link := filepath.Join(srv.d.ProjectsRoot, "repo-link")
	if err := os.Symlink(repo, link); err != nil {
		t.Skipf("创建符号链接失败: %v", err)
	}

	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()
	conn, r := dialWS(t, ts.Listener.Addr().String(), "/ws?token=secret")
	defer conn.Close()
	waitSubscribers(t, srv, systemTopic, 1)

	// 用软链路径订阅：围栏认它（真实路径在授权目录内），推送要回软链写法。
	writeCmd(t, conn, map[string]string{"kind": "git.watch", "cwd": link})
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
	if data.Cwd != link {
		t.Fatalf("推送的 cwd = %q，want 订阅时的写法 %q", data.Cwd, link)
	}

	// 同一个路径退订：之后不能再有任何推送。
	writeCmd(t, conn, map[string]string{"kind": "git.unwatch", "cwd": link})
	time.Sleep(100 * time.Millisecond)
	if err := os.WriteFile(file, []byte("three\n"), 0o600); err != nil {
		t.Fatalf("改文件: %v", err)
	}
	_ = conn.SetReadDeadline(time.Now().Add(400 * time.Millisecond))
	if _, payload, err := wsframe.ReadMessage(r, wsframe.DefaultMaxMessageBytes); err == nil {
		t.Fatalf("退订后不该再有推送，收到 %s", payload)
	}
}
