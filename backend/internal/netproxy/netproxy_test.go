package netproxy

import (
	"net/http"
	"testing"
)

func TestEnv(t *testing.T) {
	if got := Env(""); got != nil {
		t.Fatalf("空代理应返回 nil，得到 %v", got)
	}
	got := Env("  http://user:pass@127.0.0.1:7890 ")
	want := map[string]bool{
		"HTTPS_PROXY=http://user:pass@127.0.0.1:7890": true,
		"https_proxy=http://user:pass@127.0.0.1:7890": true,
		"ALL_PROXY=http://user:pass@127.0.0.1:7890":   true,
		"all_proxy=http://user:pass@127.0.0.1:7890":   true,
		"NO_PROXY=localhost,127.0.0.1,::1":            true,
		"no_proxy=localhost,127.0.0.1,::1":            true,
	}
	for _, kv := range got {
		delete(want, kv)
	}
	if len(want) != 0 {
		t.Fatalf("缺少 %v（得到 %v）", want, got)
	}
}

// SOCKS 地址必须当作「没配代理」：claude 是 Bun 打包的，收到 socks5:// 只会
// 每一轮都失败为 UnsupportedProxyProtocol，直连至少还有可能通。
func TestEnvDropsSocks(t *testing.T) {
	for _, addr := range []string{"socks5://127.0.0.1:1080", "socks5h://proxy.example:1080", "socks4://x:1"} {
		if got := Env(addr); got != nil {
			t.Fatalf("%q 应被丢弃，得到 %v", addr, got)
		}
	}
}

func TestStripEnv(t *testing.T) {
	in := []string{"PATH=/bin", "HTTPS_PROXY=http://a:1", "https_proxy=http://a:1", "no_proxy=*", "HOME=/root"}
	got := StripEnv(in)
	if len(got) != 2 || got[0] != "PATH=/bin" || got[1] != "HOME=/root" {
		t.Fatalf("StripEnv = %v", got)
	}
}

func TestFunc(t *testing.T) {
	req, _ := http.NewRequest(http.MethodGet, "https://example.com", nil)
	u, err := Func("http://127.0.0.1:7890")(req)
	if err != nil || u == nil || u.Host != "127.0.0.1:7890" {
		t.Fatalf("proxy = %v, err = %v", u, err)
	}
	if u, _ := Func("")(req); u != nil {
		t.Fatalf("空代理应直连，得到 %v", u)
	}
	if u, _ := Func("::::")(req); u != nil {
		t.Fatalf("非法地址应直连，得到 %v", u)
	}
	// SOCKS 与子进程环境一样被丢弃：Go 的 Transport 虽然能走 socks5，但面板
	// 与 claude 必须用同一条代理，否则「设置页能拉列表、会话却连不上」。
	for _, addr := range []string{"socks5://127.0.0.1:1080", "socks5h://proxy.example:1080"} {
		if u, _ := Func(addr)(req); u != nil {
			t.Fatalf("%q 应直连，得到 %v", addr, u)
		}
	}
}

// Func 与 Env 必须对「本机地址」给出一致结论：Env 里写了 NO_PROXY，
// Func 却把回环请求塞给代理，会让面板的探测/拉模型列表全部失败，
// 而 claude 子进程却是好的——用户完全看不出问题在哪。
func TestFuncSkipsLoopbackLikeEnv(t *testing.T) {
	fn := Func("http://proxy.example:7890")
	cases := []struct {
		url   string
		proxy bool
	}{
		{"http://127.0.0.1:8080/v1/models", false},
		{"http://localhost:8080/v1/models", false},
		{"http://[::1]:8080/x", false},
		{"http://127.5.6.7/x", false},
		{"https://api.example.com/v1/messages", true},
	}
	for _, c := range cases {
		req, err := http.NewRequest(http.MethodGet, c.url, nil)
		if err != nil {
			t.Fatalf("new request %s: %v", c.url, err)
		}
		u, err := fn(req)
		if err != nil {
			t.Fatalf("Func(%s): %v", c.url, err)
		}
		if got := u != nil; got != c.proxy {
			t.Fatalf("%s: proxy = %v, want %v", c.url, got, c.proxy)
		}
	}
}
