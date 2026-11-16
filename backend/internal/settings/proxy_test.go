package settings

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// 面板自己拉模型列表也必须走设置里的代理：Go 的 ProxyFromEnvironment 只读
// 进程启动时的环境变量，改设置不会生效——这里用假代理证明请求确实被代理接走。
func TestFetchModelsViaProxy(t *testing.T) {
	var seen []string
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = append(seen, r.Method+" "+r.RequestURI)
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"data":[{"id":"m1"},{"id":"m2"}]}`)
	}))
	defer proxy.Close()

	SetProxySource(func() string { return proxy.URL })
	defer SetProxySource(nil)

	p := Provider{ID: "x", Protocol: ProtocolOpenAI, BaseURL: "http://api.invalid.example"}
	res := FetchModels(context.Background(), p)

	if len(seen) == 0 {
		t.Fatal("请求没有经过代理")
	}
	if !strings.Contains(seen[0], "api.invalid.example") {
		t.Fatalf("代理收到的请求 = %v", seen)
	}
	if len(res.Models) != 2 {
		t.Fatalf("models = %+v（detail=%s）", res.Models, res.Detail)
	}
}

func TestProxyClientDirectWithoutProxy(t *testing.T) {
	SetProxySource(func() string { return "" })
	defer SetProxySource(nil)
	req, _ := http.NewRequest(http.MethodGet, "https://api.invalid.example", nil)
	u, err := proxyClient().Transport.(*http.Transport).Proxy(req)
	if err != nil || u != nil {
		t.Fatalf("空代理应直连，得到 %v / %v", u, err)
	}
}
