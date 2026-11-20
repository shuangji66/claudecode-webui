// 内置 MCP 自动化任务服务：`ccweb mcp-schedule`。
//
// 让模型能直接建提醒（「每天 9 点提醒我看天气」），而不必先让用户去面板里点。
// 它和主进程共用数据目录下的 schedules.json：Store 每次操作前按 mtime 重新加载，
// 所以两边交替写不会互相覆盖（见 internal/schedule/store.go）。
//
// 协议与 `ccweb mcp-web` 完全一致：stdio 上换行分隔的 JSON-RPC 2.0，
// **stdout 只能放协议帧**，日志一律走 stderr。
package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"ccweb/backend/internal/config"
	"ccweb/backend/internal/project"
	"ccweb/backend/internal/schedule"
	"ccweb/backend/internal/workspace"
)

// schedulesFile 返回主进程那份 schedules.json 的路径。
//
// 复用 config.Load 的解析规则：注册时我们只传 CCWEB_DATA_DIR（自建部署可能
// 另给了 CCWEB_SCHEDULES_FILE），两处各拼一次迟早会漂移。
func schedulesFile() string {
	return config.Load(version).SchedulesFile
}

func openScheduleStore() (*schedule.Store, error) {
	return schedule.Open(schedulesFile())
}

// runMCPSchedule 是子命令入口。
func runMCPSchedule() int {
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
		if resp, ok := handleScheduleRPC(req); ok {
			writeRPC(out, resp)
		}
	}
	if err := in.Err(); err != nil {
		fmt.Fprintf(os.Stderr, "ccweb mcp-schedule: 读取 stdin: %v\n", err)
		return 1
	}
	return 0
}

func handleScheduleRPC(req rpcRequest) (rpcResponse, bool) {
	id := req.ID
	isNotification := len(req.ID) == 0

	switch req.Method {
	case "initialize":
		return rpcResponse{ID: id, Result: map[string]any{
			"protocolVersion": "2025-06-18",
			"capabilities":    map[string]any{"tools": map[string]any{"listChanged": false}},
			"serverInfo":      map[string]any{"name": "ccweb-schedule", "version": version},
		}}, true
	case "notifications/initialized", "initialized", "notifications/cancelled":
		return rpcResponse{}, false
	case "ping":
		if isNotification {
			return rpcResponse{}, false
		}
		return rpcResponse{ID: id, Result: map[string]any{}}, true
	case "tools/list":
		return rpcResponse{ID: id, Result: map[string]any{"tools": scheduleToolDefs()}}, true
	case "tools/call":
		var params struct {
			Name      string          `json:"name"`
			Arguments json.RawMessage `json:"arguments"`
		}
		_ = json.Unmarshal(req.Params, &params)
		return rpcResponse{ID: id, Result: callScheduleTool(params.Name, params.Arguments)}, true
	default:
		if isNotification {
			return rpcResponse{}, false
		}
		return rpcResponse{ID: id, Error: &rpcError{Code: -32601, Message: "未知方法: " + req.Method}}, true
	}
}

// scheduleToolDefs 返回三个工具。
//
// 描述要写触发条件（这条服务是 alwaysLoad，描述原样进请求体）：模型需要知道
// 「用户说每天几点要做什么」就该调 schedule_create，而不是只在正文里答应。
func scheduleToolDefs() []map[string]any {
	ruleProps := map[string]any{
		"kind": map[string]any{
			"type":        "string",
			"enum":        []string{"once", "minutes", "hours", "daily", "weekdays", "weekly", "monthly", "cron"},
			"description": "规则类型：once 仅一次；minutes/hours 每 N 分钟/小时；daily 每天；weekdays 周一至周五；weekly 每周某几天；monthly 每月某日；cron 5 字段表达式",
		},
		"interval": map[string]any{"type": "integer", "minimum": 1, "description": "minutes/hours 的间隔"},
		"time":     map[string]any{"type": "string", "description": "HH:MM，用于 daily/weekdays/weekly/monthly"},
		"weekdays": map[string]any{"type": "array", "items": map[string]any{"type": "integer", "minimum": 0, "maximum": 6}, "description": "weekly 的星期（0=周日 … 6=周六）"},
		"day":      map[string]any{"type": "integer", "minimum": 1, "maximum": 31, "description": "monthly 的日期；该月没有这一天就落在月末"},
		"at":       map[string]any{"type": "string", "description": "once 的绝对时间，RFC3339，例如 2026-11-20T09:00:00+08:00"},
		"cron":     map[string]any{"type": "string", "description": "5 字段 cron：分 时 日 月 周，例如 0 9 * * 1-5"},
		"timezone": map[string]any{"type": "string", "description": "IANA 时区（如 Asia/Shanghai）；不填用服务器本地时区。用户没说时区时用会话里给的当前时区"},
	}
	ruleSchema := map[string]any{
		"type":                 "object",
		"properties":           ruleProps,
		"required":             []string{"kind"},
		"additionalProperties": false,
	}
	return []map[string]any{
		{
			"name": "schedule_create",
			"description": "创建一条定时任务（宿主级定时器，应用不开着某个对话也会按时运行）。" +
				"用在用户表达「每天/每周/每几分钟/过一会儿 提醒我 / 帮我做某事」时；" +
				"不要只在正文里答应「到点会提醒你」——那不会真的投递。" +
				"到点时系统会把 prompt 作为一条用户消息投进一个对话（默认新建并复用），由那时的模型去执行。" +
				"规则要能说清「哪天/几点」：用户没给时区时用系统消息里给的时区。",
			"inputSchema": map[string]any{
				"type": "object",
				"properties": map[string]any{
					"name":   map[string]any{"type": "string", "description": "任务名称，例如「每日巡检」"},
					"prompt": map[string]any{"type": "string", "description": "到点后要发给模型的那句话（自包含：模型看不到这次对话的上下文）"},
					"rule":   ruleSchema,
					"workspace": map[string]any{
						"type": "string", "description": "关联工作区（绝对路径）；不填用当前会话的工作目录",
					},
					"target": map[string]any{
						"type": "string", "enum": []string{"new-reuse", "new-each"},
						"description": "投递位置：new-reuse（默认，首次新建一个对话之后复用）/ new-each（每次新建一个对话，标题带时间）",
					},
				},
				"required":             []string{"name", "prompt", "rule"},
				"additionalProperties": false,
			},
		},
		{
			"name":        "schedule_list",
			"description": "列出全部自动化任务（含已暂停与已结束），用来回答「我有哪些提醒」或在修改/删除前确认 id。",
			"inputSchema": map[string]any{"type": "object", "properties": map[string]any{}, "additionalProperties": false},
		},
		{
			"name": "schedule_edit",
			"description": "修改、暂停、恢复或删除一条自动化任务。action 为空表示只改字段；" +
				"pause/resume 切换启用状态；delete 删除（不可恢复，删除前先确认用户真的要删）。",
			"inputSchema": map[string]any{
				"type": "object",
				"properties": map[string]any{
					"id": map[string]any{"type": "string", "description": "schedule_list 给出的任务 id"},
					"action": map[string]any{
						"type": "string", "enum": []string{"pause", "resume", "delete"},
						"description": "空=只改字段；pause 暂停；resume 恢复；delete 删除",
					},
					"name":   map[string]any{"type": "string", "description": "新名称"},
					"prompt": map[string]any{"type": "string", "description": "新的指令正文"},
					"rule":   ruleSchema,
				},
				"required":             []string{"id"},
				"additionalProperties": false,
			},
		},
	}
}

// callScheduleTool 执行一次调用。错误一律作为工具结果（isError）返回，
// 模型看得见原因才能自己改参数。
func callScheduleTool(name string, rawArgs json.RawMessage) toolContent {
	store, err := openScheduleStore()
	if err != nil {
		return errResult("读取自动化任务失败: " + err.Error())
	}
	switch name {
	case "schedule_create":
		return scheduleCreate(store, rawArgs)
	case "schedule_list":
		return scheduleList(store)
	case "schedule_edit":
		return scheduleEdit(store, rawArgs)
	default:
		return errResult("未知工具: " + name)
	}
}

type scheduleCreateArgs struct {
	Name      string        `json:"name"`
	Prompt    string        `json:"prompt"`
	Rule      schedule.Rule `json:"rule"`
	Workspace string        `json:"workspace"`
	Target    string        `json:"target"`
}

func scheduleCreate(store *schedule.Store, raw json.RawMessage) toolContent {
	var args scheduleCreateArgs
	if err := json.Unmarshal(raw, &args); err != nil {
		return errResult("参数解析失败: " + err.Error())
	}
	// 不指定工作区就用当前会话的工作目录：模型本来就跑在用户的工作区里。
	ws := strings.TrimSpace(args.Workspace)
	if ws == "" {
		if cwd, err := os.Getwd(); err == nil {
			ws = cwd
		}
	}
	if ws == "" {
		return errResult("无法确定工作区：请显式传 workspace（绝对路径）")
	}
	target := schedule.Target{Kind: schedule.TargetNewReuse}
	if args.Target == schedule.TargetNewEach {
		target = schedule.Target{Kind: schedule.TargetNewEach}
	}
	// 先校验规则与字段（模型改参数时最常错的就是这些），再解析工作区：
	// 反过来的话一个写错的 cron 会被「工作区未授权」盖住，模型只能瞎猜。
	task := schedule.Task{
		Name:      strings.TrimSpace(args.Name),
		Prompt:    strings.TrimSpace(args.Prompt),
		Target:    target,
		Workspace: ws,
		Rule:      args.Rule,
	}
	if err := task.Validate(); err != nil {
		return errResult(err.Error())
	}
	now := time.Now()
	next, ok := args.Rule.Next(now)
	if !ok {
		return errResult("这条规则没有下一次发生时间（仅一次任务的时间要在将来）")
	}
	// 落成绝对路径并核对授权：模型可能传相对路径（"." 会按**主进程**的 cwd 解析，
	// 那是另一个目录），也可能传一个没授权过的目录。不在这里挡，任务会创建成功、
	// 到点每轮投递都失败一次，而模型当时看到的是「已创建」。
	abs, err := resolveWorkspace(ws)
	if err != nil {
		return errResult(err.Error())
	}
	task.Workspace = abs
	task.NextRun = &next
	created, err := store.Create(task)
	if err != nil {
		return errResult("创建失败: " + err.Error())
	}
	return okResult(fmt.Sprintf(
		"已创建自动化任务：%s（id %s）。%s，下次运行 %s，工作区 %s。\n到点后系统会把指令投进对话；用户在「自动化任务」面板里可以随时暂停或删除。",
		created.Name, created.ID, describeRule(created.Rule), next.Local().Format("2006-01-02 15:04"), created.Workspace,
	))
}

// resolveWorkspace 把工作区落成绝对路径，并核对它在用户的授权目录内。
//
// 主进程投递时还会再挡一次（那才是真正的围栏），这里提前挡只为了一句能看懂的
// 原因：让模型知道「这个目录不能当执行位置」，而不是给它一条永远失败的任务。
func resolveWorkspace(raw string) (string, error) {
	abs, err := project.Validate(raw)
	if err != nil {
		return "", fmt.Errorf("工作区不可用: %w", err)
	}
	real, err := filepath.EvalSymlinks(abs)
	if err != nil {
		return "", errors.New("工作区不可用: 无法解析目录的真实路径")
	}
	cfg := config.Load(version)
	ws, err := workspace.Open(cfg.WorkspacesFile, "")
	if err != nil {
		return "", fmt.Errorf("读取授权目录失败: %w", err)
	}
	if !ws.Allows(real) && (cfg.ProjectsRoot == "" || filepath.Clean(real) != filepath.Clean(cfg.ProjectsRoot)) {
		return "", fmt.Errorf("工作区未授权：%s 不在用户已授权的目录里；请用会话当前工作目录，或先让用户在侧栏添加该目录", abs)
	}
	return abs, nil
}

func scheduleList(store *schedule.Store) toolContent {
	tasks := store.List()
	if len(tasks) == 0 {
		return okResult("当前没有任何自动化任务。")
	}
	var b strings.Builder
	fmt.Fprintf(&b, "共 %d 条自动化任务：\n", len(tasks))
	for _, t := range tasks {
		next := "—"
		if t.NextRun != nil {
			next = t.NextRun.Local().Format("2006-01-02 15:04")
		}
		fmt.Fprintf(&b, "\n- id %s｜%s｜%s｜%s｜下次 %s", t.ID, t.Name, statusText(t.Status), describeRule(t.Rule), next)
		if t.LastError != "" {
			fmt.Fprintf(&b, "｜上次投递失败：%s", t.LastError)
		}
	}
	return okResult(b.String())
}

func scheduleEdit(store *schedule.Store, raw json.RawMessage) toolContent {
	var args struct {
		ID     string         `json:"id"`
		Action string         `json:"action"`
		Name   string         `json:"name"`
		Prompt string         `json:"prompt"`
		Rule   *schedule.Rule `json:"rule"`
	}
	if err := json.Unmarshal(raw, &args); err != nil {
		return errResult("参数解析失败: " + err.Error())
	}
	args.ID = strings.TrimSpace(args.ID)
	if args.ID == "" {
		return errResult("缺少 id：先用 schedule_list 查一下")
	}
	if _, ok := store.Get(args.ID); !ok {
		return errResult("找不到这条任务（可能已被删除）")
	}
	switch args.Action {
	case "", "pause", "resume", "delete":
	default:
		return errResult("未知 action: " + args.Action)
	}

	if args.Action == "delete" {
		if _, err := store.Delete(args.ID); err != nil {
			return errResult("删除失败: " + err.Error())
		}
		return okResult("已删除这条自动化任务，之后不会再投递。")
	}

	if args.Rule != nil {
		if err := args.Rule.Validate(); err != nil {
			return errResult(err.Error())
		}
	}
	updated, err := store.Update(args.ID, func(t *schedule.Task) error {
		if n := strings.TrimSpace(args.Name); n != "" {
			t.Name = n
		}
		if p := strings.TrimSpace(args.Prompt); p != "" {
			t.Prompt = p
		}
		if args.Rule != nil {
			t.Rule = *args.Rule
			next, ok := args.Rule.Next(time.Now())
			if !ok {
				return fmt.Errorf("这条规则没有下一次发生时间（仅一次任务的时间要在将来）")
			}
			t.NextRun = &next
			// 改了规则就重新激活：已结束的任务说明旧规则跑完了。
			if t.Status == schedule.StatusEnded {
				t.Status = schedule.StatusActive
			}
		}
		switch args.Action {
		case "pause":
			t.Status = schedule.StatusPaused
		case "resume":
			if t.Status != schedule.StatusActive || t.NextRun == nil {
				next, ok := t.Rule.Next(time.Now())
				if !ok {
					return fmt.Errorf("这条规则已经没有下一次发生时间")
				}
				t.Status = schedule.StatusActive
				t.NextRun = &next
			}
		}
		return nil
	})
	if err != nil {
		return errResult("修改失败: " + err.Error())
	}
	next := "—"
	if updated.NextRun != nil {
		next = updated.NextRun.Local().Format("2006-01-02 15:04")
	}
	return okResult(fmt.Sprintf("已更新：%s｜%s｜%s｜下次 %s", updated.Name, statusText(updated.Status), describeRule(updated.Rule), next))
}

func statusText(status string) string {
	switch status {
	case schedule.StatusActive:
		return "已开启"
	case schedule.StatusPaused:
		return "已暂停"
	case schedule.StatusEnded:
		return "已结束"
	}
	return status
}

// describeRule 给模型看的一句话规则描述（与界面上的文案各自独立，这里更短）。
func describeRule(r schedule.Rule) string {
	switch r.Kind {
	case schedule.KindOnce:
		return "仅一次 " + r.At
	case schedule.KindMinutes:
		return fmt.Sprintf("每 %d 分钟", r.Interval)
	case schedule.KindHours:
		return fmt.Sprintf("每 %d 小时", r.Interval)
	case schedule.KindDaily:
		return "每天 " + r.Time
	case schedule.KindWeekdays:
		return "周一至周五 " + r.Time
	case schedule.KindWeekly:
		return fmt.Sprintf("每周 %v %s", r.Weekdays, r.Time)
	case schedule.KindMonthly:
		return fmt.Sprintf("每月 %d 日 %s", r.Day, r.Time)
	case schedule.KindCron:
		return "cron " + r.Cron
	}
	return r.Kind
}
