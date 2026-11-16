package settings

import (
	"net/http"
	"strings"

	"ccweb/backend/internal/netproxy"
)

// proxySource 返回面板设置里的代理地址（空 = 直连）。
//
// 面板自己的出站请求（拉模型列表、探测端点、验证模型）走的是 Go 的 http 客户端，
// 而 http.ProxyFromEnvironment 只读**进程启动时**的环境变量——代理设置改了它不会变。
// 装配层启动时把 Store 的取值函数注册进来，这里每次请求现取。
var proxySource func() string

// SetProxySource 注册代理来源；装配层调用一次。
func SetProxySource(fn func() string) {
	proxySource = fn
}

// currentProxy 返回当前代理地址（未注册时为空）。
func currentProxy() string {
	if proxySource == nil {
		return ""
	}
	return strings.TrimSpace(proxySource())
}

// proxyClient 构造带代理的探测客户端。
//
// 复用 DefaultTransport 的默认参数（DialContext / TLS 握手超时等）再覆盖 Proxy，
// 不要手写一个零值 Transport：那样会丢掉连接池与超时默认值。
func proxyClient() *http.Client {
	tr := http.DefaultTransport.(*http.Transport).Clone()
	tr.Proxy = netproxy.Func(currentProxy())
	return &http.Client{Timeout: ProbeTimeout, Transport: tr}
}
