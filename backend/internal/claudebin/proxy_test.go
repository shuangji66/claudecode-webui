package claudebin

import (
	"fmt"
	"net/http"
	"testing"
)

// 下载 claude 走的是面板设置里的代理：ProxyFromEnvironment 只认启动时的环境变量，
// 所以这里显式断言取值函数被用上。
func TestProxyForRequest(t *testing.T) {
	req, _ := http.NewRequest(http.MethodGet, "https://registry.npmmirror.com/@anthropic-ai/claude-code-linux-x64", nil)

	SetProxySource(func() string { return "http://127.0.0.1:7890" })
	u, err := proxyForRequest(req)
	if err != nil || u == nil || u.Host != "127.0.0.1:7890" {
		t.Fatalf("proxy = %v, err = %v", u, err)
	}

	// 空设置时退回进程环境。注意 Go 会把环境代理缓存下来（envProxyOnce），
	// 所以这里不能断言具体值，只断言和直接调用 ProxyFromEnvironment 一致。
	SetProxySource(func() string { return "" })
	defer SetProxySource(nil)
	want, wantErr := http.ProxyFromEnvironment(req)
	got, gotErr := proxyForRequest(req)
	if fmt.Sprint(got) != fmt.Sprint(want) || fmt.Sprint(gotErr) != fmt.Sprint(wantErr) {
		t.Fatalf("环境变量兜底不一致: got %v/%v, want %v/%v", got, gotErr, want, wantErr)
	}
}
