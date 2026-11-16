package netproxy

import (
	"net/http"
	"testing"
)

func TestEnv(t *testing.T) {
	if got := Env(""); got != nil {
		t.Fatalf("空代理应返回 nil，得到 %v", got)
	}
	got := Env("  socks5h://user:pass@127.0.0.1:1080 ")
	want := map[string]bool{
		"HTTPS_PROXY=socks5h://user:pass@127.0.0.1:1080": true,
		"https_proxy=socks5h://user:pass@127.0.0.1:1080": true,
		"ALL_PROXY=socks5h://user:pass@127.0.0.1:1080":   true,
		"all_proxy=socks5h://user:pass@127.0.0.1:1080":   true,
		"NO_PROXY=localhost,127.0.0.1,::1":               true,
		"no_proxy=localhost,127.0.0.1,::1":               true,
	}
	for _, kv := range got {
		delete(want, kv)
	}
	if len(want) != 0 {
		t.Fatalf("缺少 %v（得到 %v）", want, got)
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
