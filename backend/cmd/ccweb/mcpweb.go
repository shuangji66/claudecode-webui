// 内置 MCP 搜索服务：`ccweb mcp-web`。
//
// 为什么是 MCP 而不是 Claude Code 的 plugin：claude 的 plugin 要走 marketplace 与
// `claude plugin` 安装，本项目没有那条链路；而 MCP 是本项目已经管起来的东西
// （设置 → MCP），一个子命令 + 一条配置就能让会话多出 web_search / web_fetch。
//
// 为什么用本二进制当命令：不引入任何 Node 依赖，且配置（基地址/密钥）跟主进程
// 读同一份 settings.json——每次调用现读，改了设置不用重开会话（进程还是同一个）。
//
// 协议：MCP over stdio，换行分隔的 JSON-RPC 2.0。**stdout 只能放协议帧**，
// 任何日志都必须走 stderr，否则 claude 侧会解析失败。
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"

	"ccweb/backend/internal/config"
	"ccweb/backend/internal/search"
	"ccweb/backend/internal/settings"
)

// 工具名与 claude 侧的最终名字无关（会是 mcp__<server>__web_search），
// 但保持和 DSH 一致，便于用户对照文档。
const (
	toolWebSearch = "web_search"
	toolWebFetch  = "web_fetch"
)

// 输出上限：搜索结果进的是主对话上下文，塞满会把上下文吃掉。
const (
	maxSearchText = 6000
	maxFetchText  = 40000
	maxSnippet    = 400
)

type rpcRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type rpcResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Result  any             `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

// toolContent 是 tools/call 的返回体。
type toolContent struct {
	Content []map[string]any `json:"content"`
	IsError bool             `json:"isError,omitempty"`
}

// settingsFile 返回主进程那份 settings.json 的路径。
//
// 直接复用 config.Load 的解析规则，不再手拼一份：注册时我们只传 CCWEB_DATA_DIR
// （自建部署可能改过数据目录，也可能另给了 CCWEB_SETTINGS_FILE），两处各拼一次
// 迟早会漂移。**尤其不能用相对路径兜底**：子进程的 cwd 是用户的工作区，
// `data/settings.json` 会去读工作区里那个文件，读不到就报「未启用」，
// 用户完全看不出是路径错了。
func settingsFile() string {
	return config.Load(version).SettingsFile
}

// loadSearchSettings 每次调用现读，保证界面改完立即生效。
func loadSearchSettings() (settings.Settings, error) {
	store, err := settings.Open(settingsFile())
	if err != nil {
		return settings.Settings{}, err
	}
	return store.Get(), nil
}

// proxySource 返回「当前代理」的取值函数，逐次现读设置。
//
// 子命令是**独立进程**：主进程那套 SetProxySource（cmd/ccweb 里接 settings）不会
// 继承过来，而 http.ProxyFromEnvironment 只读进程启动时的环境变量。不在这里接上，
// 界面配了代理、设置页「测试连接」也通，模型真正调 web_search 时却连不出去。
func proxySource() func() string {
	return func() string {
		cur, err := loadSearchSettings()
		if err != nil {
			return ""
		}
		return cur.ProxyURL
	}
}

// runMCPWeb 是子命令入口：读 stdin 的 JSON-RPC 帧，往 stdout 写回包。
func runMCPWeb() int {
	search.SetProxySource(proxySource())
	in := bufio.NewScanner(os.Stdin)
	in.Buffer(make([]byte, 0, 64<<10), 4<<20)
	out := bufio.NewWriter(os.Stdout)
	defer func() { _ = out.Flush() }()

	for in.Scan() {
		line := strings.TrimSpace(in.Text())
		if line == "" {
			continue
		}
		var req rpcRequest
		if err := json.Unmarshal([]byte(line), &req); err != nil {
			writeRPC(out, rpcResponse{JSONRPC: "2.0", Error: &rpcError{Code: -32700, Message: "解析失败: " + err.Error()}})
			continue
		}
		resp, hasResp := handleRPC(req)
		if hasResp {
			writeRPC(out, resp)
		}
	}
	if err := in.Err(); err != nil {
		fmt.Fprintf(os.Stderr, "ccweb mcp-web: 读取 stdin: %v\n", err)
		return 1
	}
	return 0
}

func writeRPC(w io.Writer, resp rpcResponse) {
	if resp.JSONRPC == "" {
		resp.JSONRPC = "2.0"
	}
	b, err := json.Marshal(resp)
	if err != nil {
		return
	}
	_, _ = w.Write(append(b, '\n'))
	if f, ok := w.(*bufio.Writer); ok {
		_ = f.Flush()
	}
}

// handleRPC 分发一条请求；hasResp=false 表示这是通知，不需要回包。
func handleRPC(req rpcRequest) (rpcResponse, bool) {
	// 通知：initialized / cancelled 之类，没有 id，也不允许回包。
	isNotification := len(req.ID) == 0
	id := req.ID

	switch req.Method {
	case "initialize":
		return rpcResponse{ID: id, Result: map[string]any{
			"protocolVersion": "2025-06-18",
			"capabilities":    map[string]any{"tools": map[string]any{"listChanged": false}},
			"serverInfo":      map[string]any{"name": "ccweb-web", "version": version},
		}}, true
	case "notifications/initialized", "initialized", "notifications/cancelled":
		return rpcResponse{}, false
	case "ping":
		if isNotification {
			return rpcResponse{}, false
		}
		return rpcResponse{ID: id, Result: map[string]any{}}, true
	case "tools/list":
		return rpcResponse{ID: id, Result: map[string]any{"tools": toolDefs()}}, true
	case "tools/call":
		var params struct {
			Name      string          `json:"name"`
			Arguments json.RawMessage `json:"arguments"`
		}
		_ = json.Unmarshal(req.Params, &params)
		return rpcResponse{ID: id, Result: callTool(params.Name, params.Arguments)}, true
	default:
		if isNotification {
			return rpcResponse{}, false
		}
		return rpcResponse{ID: id, Error: &rpcError{Code: -32601, Message: "未知方法: " + req.Method}}, true
	}
}

func toolDefs() []map[string]any {
	return []map[string]any{
		{
			"name": toolWebSearch,
			"description": "搜索互联网并返回结构化结果（标题 + 链接 + 摘要），走 DeepSeek Search API。" +
				"需要正文时再用 web_fetch 打开具体链接。",
			"inputSchema": map[string]any{
				"type": "object",
				"properties": map[string]any{
					"query":       map[string]any{"type": "string", "description": "搜索词"},
					"max_results": map[string]any{"type": "integer", "minimum": 1, "maximum": 50, "description": "需要的条数；实际取它与设置里「结果条数」的较小值（设置是花费上限）"},
				},
				"required":             []string{"query"},
				"additionalProperties": false,
			},
		},
		{
			"name":        toolWebFetch,
			"description": "抓取一个网页并返回 Markdown 正文（DeepSeek Fetch API），超长会被截断。",
			"inputSchema": map[string]any{
				"type": "object",
				"properties": map[string]any{
					"url": map[string]any{"type": "string", "description": "http(s) 地址"},
				},
				"required":             []string{"url"},
				"additionalProperties": false,
			},
		},
	}
}

// callTool 执行一次工具调用。错误一律**作为工具结果**返回（isError），
// 而不是 JSON-RPC error：模型看得见原因，才能自己改参数或换思路。
func callTool(name string, rawArgs json.RawMessage) toolContent {
	var args struct {
		Query      string `json:"query"`
		MaxResults int    `json:"max_results"`
		URL        string `json:"url"`
	}
	if len(rawArgs) > 0 {
		if err := json.Unmarshal(rawArgs, &args); err != nil {
			return errResult("参数解析失败: " + err.Error())
		}
	}

	cur, err := loadSearchSettings()
	if err != nil {
		return errResult("读取设置失败: " + err.Error())
	}
	if !cur.SearchEnabled {
		return errResult("内置搜索未启用：请在「设置 → MCP → 内置搜索」里打开并填写密钥")
	}
	base, key, count := cur.SearchBaseURL, cur.SearchAPIKey, cur.SearchCount

	switch name {
	case toolWebSearch:
		// 设置里的条数是**花费上限**：模型可以要得更少，但不能要到更多。
		if args.MaxResults > 0 && args.MaxResults < count {
			count = args.MaxResults
		}
		results, err := search.Search(context.Background(), base, key, args.Query, count)
		if err != nil {
			return errResult(err.Error())
		}
		return okResult(formatResults(args.Query, results))
	case toolWebFetch:
		md, err := search.Fetch(context.Background(), base, key, args.URL)
		if err != nil {
			return errResult(err.Error())
		}
		return okResult(truncate(md, maxFetchText, "\n\n…（已截断，原页面更长）"))
	default:
		return errResult("未知工具: " + name)
	}
}

func okResult(text string) toolContent {
	return toolContent{Content: []map[string]any{{"type": "text", "text": text}}}
}

func errResult(msg string) toolContent {
	return toolContent{Content: []map[string]any{{"type": "text", "text": msg}}, IsError: true}
}

// formatResults 把结果排成模型好读的紧凑列表；空结果也要明说。
func formatResults(query string, results []search.Result) string {
	if len(results) == 0 {
		return fmt.Sprintf("没有找到结果（查询：%s）。可以换个说法，或用 web_fetch 直接打开已知链接。", strings.TrimSpace(query))
	}
	var b strings.Builder
	fmt.Fprintf(&b, "查询：%s，共 %d 条结果\n", strings.TrimSpace(query), len(results))
	for i, r := range results {
		fmt.Fprintf(&b, "\n%d. %s\n   %s\n", i+1, strings.TrimSpace(r.Title), r.URL)
		if d := strings.TrimSpace(r.Date); d != "" {
			fmt.Fprintf(&b, "   日期：%s\n", d)
		}
		// summary 是模型向的摘录，snippet 是展示向；两个都有就都带上（各自截断）。
		if s := strings.TrimSpace(r.Summary); s != "" {
			fmt.Fprintf(&b, "   摘要：%s\n", truncate(s, maxSnippet, "…"))
		} else if s := strings.TrimSpace(r.Snippet); s != "" {
			fmt.Fprintf(&b, "   摘要：%s\n", truncate(s, maxSnippet, "…"))
		}
	}
	return truncate(b.String(), maxSearchText, "\n…（结果过多，已截断）")
}

// truncate 按 rune 截断，避免把 UTF-8 切坏。
func truncate(s string, limit int, suffix string) string {
	if limit <= 0 {
		return s
	}
	r := []rune(s)
	if len(r) <= limit {
		return s
	}
	return string(r[:limit]) + suffix
}
