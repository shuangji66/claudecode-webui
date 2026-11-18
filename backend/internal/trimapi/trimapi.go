// Package trimapi 调用飞牛的「应用开放 API」（统一网关 apiscope）。
//
// 三个硬约束，都来自飞牛官方文档，改代码时不要绕：
//
//  1. **只能由应用服务端经 Unix Socket 调用**（`/var/run/trim_open_gateway_apiscope.socket`），
//     不是 HTTP 端口、更不能从浏览器直接调。
//  2. **token 由飞牛在启动 `cmd/main` 时注入环境变量 `TRIM_API_TOKEN`**，官方要求每次
//     调用现读、不落盘、不下发前端：应用重新注册/重装后 token 会变，缓存一份就 401。
//  3. **scope 必须在包的 `config/resource` 里声明**（这里是 `trim.file.userAccess`），
//     否则网关回 1000002/200004，与本包无关但报错要能看懂。
//
// 这里只做「查询/删除用户授权目录」两件事。**授权本身不能在这里做**：它必须由用户
// 在选择器或授权页上确认（前端 `lib/fnos.ts` 的 pickUserFile / openAppAuth）。
package trimapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"time"
)

const (
	// DefaultSocket 是飞牛应用网关的固定位置；`CCWEB_TRIM_SOCKET` 只用于测试与联调。
	DefaultSocket = "/var/run/trim_open_gateway_apiscope.socket"

	// 网关不给 reqId 时会原样回空串，所以它只是排障线索，不参与业务判断。
	requestPath = "/api/v1/trimapp"
	callTimeout = 8 * time.Second
)

// Client 是「已授权目录」的读写入口。
type Client struct {
	SocketPath string
	AppName    string
	// Token 现读环境变量：飞牛会换 token，缓存一份就是 401。
	Token func() string
	HTTP  *http.Client
}

// New 构造客户端。socket / app / token 全部由装配层给出（config 是唯一读环境变量的地方）。
//
// 不在飞牛里跑时这些值取默认，真正调用时才会因为缺 token / 连不上 socket 报错：
// 启动阶段不该因此失败，否则非飞牛部署连设置页都进不去。
func New(socketPath, appName string, token func() string) *Client {
	if socketPath == "" {
		socketPath = DefaultSocket
	}
	c := &Client{
		SocketPath: socketPath,
		AppName:    appName,
		Token:      token,
	}
	c.HTTP = &http.Client{
		Timeout: callTimeout,
		Transport: &http.Transport{
			DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
				var d net.Dialer
				return d.DialContext(ctx, "unix", socketPath)
			},
			// 网关是本机 socket，别走环境里的 HTTP 代理（NAS 上经常配了代理）。
			Proxy: nil,
		},
	}
	return c
}

// Envelope 是网关的请求/响应外壳。data 的类型随 req 变化。
type envelope struct {
	ReqID   string          `json:"reqId"`
	Req     string          `json:"req"`
	AppName string          `json:"appName"`
	Data    json.RawMessage `json:"data"`
	// 响应字段
	Code int    `json:"code"`
	Msg  string `json:"msg"`
}

// Error 是网关返回的业务错误（code != 0），带上 req 便于定位 scope/uid 问题。
type Error struct {
	Req  string
	Code int
	Msg  string
}

func (e *Error) Error() string {
	msg := e.Msg
	if msg == "" {
		msg = "未知错误"
	}
	return fmt.Sprintf("飞牛接口 %s 失败（%d）：%s", e.Req, e.Code, msg)
}

// ErrNoToken 表示当前进程没有拿到飞牛注入的 API token（不在飞牛里跑，或不是从 cmd/main 启动）。
var ErrNoToken = errors.New("缺少 TRIM_API_TOKEN：本应用不是由飞牛启动的，或未在 config/resource 里声明 trim.file.userAccess")

// List 返回 uid 授权给本应用的目录路径。
func (c *Client) List(uid int) ([]string, error) {
	var out struct {
		Paths []string `json:"paths"`
	}
	if err := c.call("trim.file.getUserAccessibleFolders", map[string]any{"uid": uid}, &out); err != nil {
		return nil, err
	}
	// 网关可能给 null；前端要的是数组，这里统一成空切片。
	if out.Paths == nil {
		return []string{}, nil
	}
	return out.Paths, nil
}

// Remove 撤销 uid 对 path 的授权。
func (c *Client) Remove(uid int, path string) error {
	var out struct {
		Suc bool `json:"suc"`
	}
	if err := c.call("trim.file.delUserAccessibleFolder", map[string]any{"uid": uid, "path": path}, &out); err != nil {
		return err
	}
	if !out.Suc {
		return fmt.Errorf("飞牛没有撤销 %s 的授权（suc=false）", path)
	}
	return nil
}

// call 发一次 POST /api/v1/trimapp，把 code != 0 折成 *Error。
func (c *Client) call(req string, data any, out any) error {
	token := ""
	if c.Token != nil {
		token = c.Token()
	}
	if token == "" {
		return ErrNoToken
	}
	raw, err := json.Marshal(data)
	if err != nil {
		return err
	}
	body, err := json.Marshal(envelope{
		ReqID:   fmt.Sprintf("%d", time.Now().UnixNano()),
		Req:     req,
		AppName: c.AppName,
		Data:    raw,
	})
	if err != nil {
		return err
	}

	httpReq, err := http.NewRequest(http.MethodPost, "http://localhost"+requestPath, bytes.NewReader(body))
	if err != nil {
		return err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Authorization", "Bearer "+token)

	client := c.HTTP
	if client == nil {
		client = &http.Client{Timeout: callTimeout}
	}
	res, err := client.Do(httpReq)
	if err != nil {
		// 连不上 socket 是最常见的现场（不是飞牛部署、socket 权限没给到应用用户）。
		return fmt.Errorf("连不上飞牛应用网关（%s）：%w", c.SocketPath, err)
	}
	defer func() { _ = res.Body.Close() }()

	var resp envelope
	if err := json.NewDecoder(res.Body).Decode(&resp); err != nil {
		// 401/404 时网关回的是另一套 JSON（code 是字符串），解码失败也要给出状态码。
		return fmt.Errorf("飞牛应用网关返回了无法解析的响应（HTTP %d）", res.StatusCode)
	}
	if resp.Code != 0 {
		return &Error{Req: req, Code: resp.Code, Msg: resp.Msg}
	}
	if out != nil {
		if len(resp.Data) == 0 {
			return nil
		}
		if err := json.Unmarshal(resp.Data, out); err != nil {
			return fmt.Errorf("飞牛接口 %s 的返回格式不认识：%w", req, err)
		}
	}
	return nil
}
