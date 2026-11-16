// Package netproxy 把「设置里的代理」落到真正出站的请求上。
//
// 为什么需要它：Go 的 http.ProxyFromEnvironment 只读**进程启动时**的环境变量，
// 而代理是本应用里可随时修改的设置。于是面板自己的请求（拉模型列表、探测端点、
// 下载 claude）以及 spawn 出来的 git 子进程都不会走代理——用户配了代理却看不到
// 任何流量。这个包把「当前代理地址」翻译成 HTTP 客户端与子进程环境两套形式。
package netproxy

import (
	"net/http"
	"net/url"
	"strings"
)

// 本地回环永远直连：中继、终端、健康检查都在本机，绕到外部代理只会失败。
const noProxyValue = "localhost,127.0.0.1,::1"

// Func 返回 http.Transport.Proxy 需要的回调；代理为空表示直连。
//
// 地址非法时按直连处理：设置层已经校验过协议，这里只是防御性兜底，
// 不能因为一个坏地址让所有请求都抛错。
func Func(proxy string) func(*http.Request) (*url.URL, error) {
	proxy = strings.TrimSpace(proxy)
	if proxy == "" {
		return func(*http.Request) (*url.URL, error) { return nil, nil }
	}
	u, err := url.Parse(proxy)
	if err != nil || u.Host == "" {
		return func(*http.Request) (*url.URL, error) { return nil, nil }
	}
	return func(*http.Request) (*url.URL, error) { return u, nil }
}

// Env 返回给子进程用的代理环境变量；代理为空时返回 nil（直连）。
//
// 大小写两套都写：git 走的 libcurl 两套都认，而有些工具只认其中一套
// （claude CLI 只认小写 https_proxy，见 backend/AGENTS.md）。
func Env(proxy string) []string {
	proxy = strings.TrimSpace(proxy)
	if proxy == "" {
		return nil
	}
	out := make([]string, 0, 10)
	for _, key := range []string{
		"HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY",
		"https_proxy", "http_proxy", "all_proxy",
	} {
		out = append(out, key+"="+proxy)
	}
	out = append(out, "NO_PROXY="+noProxyValue, "no_proxy="+noProxyValue)
	return out
}

// proxyKeys 是需要在子进程环境里先剔除的变量名（继承值会和面板设置打架）。
var proxyKeys = []string{
	"HTTPS_PROXY=", "HTTP_PROXY=", "ALL_PROXY=", "SOCKS_PROXY=", "NO_PROXY=",
	"https_proxy=", "http_proxy=", "all_proxy=", "socks_proxy=", "no_proxy=",
}

// StripEnv 剔除继承环境里的代理变量。
func StripEnv(env []string) []string {
	out := make([]string, 0, len(env))
	for _, kv := range env {
		skip := false
		for _, key := range proxyKeys {
			if strings.HasPrefix(kv, key) {
				skip = true
				break
			}
		}
		if !skip {
			out = append(out, kv)
		}
	}
	return out
}
