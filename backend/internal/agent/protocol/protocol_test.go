package protocol

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestDecodeControlRequestUsesTopLevelID(t *testing.T) {
	line := []byte(`{"type":"control_request","request_id":"r1","request":{"subtype":"can_use_tool","tool_name":"Bash"}}`)
	env, err := Decode(line)
	if err != nil {
		t.Fatalf("Decode: %v", err)
	}
	if env.Type != TypeControlRequest {
		t.Fatalf("type = %q", env.Type)
	}
	if env.RequestID != "r1" {
		t.Fatalf("RequestID = %q, want r1", env.RequestID)
	}
	if env.Subtype != SubtypeCanUseTool {
		t.Fatalf("Subtype = %q", env.Subtype)
	}
	if len(env.Raw) == 0 {
		t.Fatal("Raw 不应为空（需要原样透传给前端）")
	}
}

// TestDecodeControlResponseNestedID 覆盖本项目踩过的坑：
// control_response 的 request_id 在 response.request_id，不在顶层。
func TestDecodeControlResponseNestedID(t *testing.T) {
	line := []byte(`{"type":"control_response","response":{"subtype":"success","request_id":"init","response":{"models":[]}}}`)
	env, err := Decode(line)
	if err != nil {
		t.Fatalf("Decode: %v", err)
	}
	if env.RequestID != "" {
		t.Fatalf("顶层 RequestID 应为空，实际 %q", env.RequestID)
	}
	if env.RespRequestID != "init" {
		t.Fatalf("RespRequestID = %q, want init", env.RespRequestID)
	}
	payload := env.ResponsePayload()
	if string(payload) != `{"models":[]}` {
		t.Fatalf("payload = %s", payload)
	}
}

func TestDecodeInvalid(t *testing.T) {
	if _, err := Decode([]byte("not json")); err == nil {
		t.Fatal("期望解析错误")
	}
}

func TestInitializeShape(t *testing.T) {
	var got map[string]any
	if err := json.Unmarshal(Initialize("rid"), &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if got["type"] != TypeControlRequest || got["request_id"] != "rid" {
		t.Fatalf("顶层字段不对: %v", got)
	}
	req := got["request"].(map[string]any)
	if req["subtype"] != SubtypeInitialize {
		t.Fatalf("subtype = %v", req["subtype"])
	}
	// hooks/agents 必须显式存在（null），否则某些版本会拒绝握手。
	if _, ok := req["hooks"]; !ok {
		t.Fatal("request 缺少 hooks 字段")
	}
	if _, ok := req["agents"]; !ok {
		t.Fatal("request 缺少 agents 字段")
	}
	// 子代理进度摘要：只在 initialize 里声明（没有环境变量、先于首条消息发出）。
	if req["agentProgressSummaries"] != true {
		t.Fatalf("agentProgressSummaries = %v", req["agentProgressSummaries"])
	}
}

func TestUserTextShape(t *testing.T) {
	var got map[string]any
	if err := json.Unmarshal(UserText("你好"), &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if got["type"] != TypeUser {
		t.Fatalf("type = %v", got["type"])
	}
	if got["session_id"] != nil {
		t.Fatalf("session_id 应为 null，实际 %v", got["session_id"])
	}
	msg := got["message"].(map[string]any)
	content := msg["content"].([]any)
	block := content[0].(map[string]any)
	if block["type"] != "text" || block["text"] != "你好" {
		t.Fatalf("content block = %v", block)
	}
}

func TestAllowAndDeny(t *testing.T) {
	var allow map[string]any
	_ = json.Unmarshal(Allow("r1", json.RawMessage(`{"command":"ls"}`)), &allow)
	resp := allow["response"].(map[string]any)
	if resp["request_id"] != "r1" || resp["subtype"] != "success" {
		t.Fatalf("response = %v", resp)
	}
	inner := resp["response"].(map[string]any)
	if inner["behavior"] != "allow" {
		t.Fatalf("behavior = %v", inner["behavior"])
	}
	if inner["updatedInput"] == nil {
		t.Fatal("updatedInput 应被透传")
	}

	var deny map[string]any
	_ = json.Unmarshal(Deny("r2", "太危险"), &deny)
	inner = deny["response"].(map[string]any)["response"].(map[string]any)
	if inner["behavior"] != "deny" || inner["message"] != "太危险" {
		t.Fatalf("deny = %v", inner)
	}
}

func TestParsePermission(t *testing.T) {
	line := []byte(`{"type":"control_request","request_id":"p1","request":{
		"subtype":"can_use_tool","tool_name":"Bash","display_name":"Bash",
		"input":{"command":"rm -rf /tmp/x"},"blocked_path":"/tmp/x","tool_use_id":"tu1",
		"permission_suggestions":[{"type":"setMode","mode":"acceptEdits"}]}}`)
	env, err := Decode(line)
	if err != nil {
		t.Fatalf("Decode: %v", err)
	}
	p, ok := ParsePermission(env)
	if !ok {
		t.Fatal("应识别为权限请求")
	}
	if p.RequestID != "p1" || p.ToolName != "Bash" || p.BlockedPath != "/tmp/x" {
		t.Fatalf("解析结果不对: %+v", p)
	}
	if len(p.PermissionSuggestions) == 0 {
		t.Fatal("permission_suggestions 应原样保留")
	}
}

func TestParsePermissionRejectsOtherSubtypes(t *testing.T) {
	line := []byte(`{"type":"control_request","request_id":"x","request":{"subtype":"interrupt"}}`)
	env, _ := Decode(line)
	if _, ok := ParsePermission(env); ok {
		t.Fatal("非 can_use_tool 不应被识别")
	}
}

func TestUnsupportedHasErrorCode(t *testing.T) {
	var got map[string]any
	_ = json.Unmarshal(Unsupported("bad"), &got)
	resp := got["response"].(map[string]any)
	if resp["subtype"] != "error" || resp["error_code"] != "unsupported_request" {
		t.Fatalf("response = %v", resp)
	}
}

func TestUserMessageAttachments(t *testing.T) {
	line := UserMessage("看图", []Attachment{
		{Name: "a.png", MediaType: "image/png", Data: []byte("png")},
		{Name: "a.pdf", MediaType: "application/pdf", Data: []byte("pdf")},
		{Name: "a.txt", MediaType: "text/plain", Data: []byte("hello")},
	})
	var msg struct {
		Message struct {
			Content []struct {
				Type   string `json:"type"`
				Text   string `json:"text"`
				Source struct {
					MediaType string `json:"media_type"`
					Data      string `json:"data"`
				} `json:"source"`
			} `json:"content"`
		} `json:"message"`
	}
	if err := json.Unmarshal(line, &msg); err != nil {
		t.Fatal(err)
	}
	if len(msg.Message.Content) != 4 {
		t.Fatalf("blocks = %+v", msg.Message.Content)
	}
	if msg.Message.Content[0].Type != "text" || msg.Message.Content[0].Text != "看图" {
		t.Fatalf("首块 = %+v", msg.Message.Content[0])
	}
	if msg.Message.Content[1].Type != "image" || msg.Message.Content[1].Source.MediaType != "image/png" {
		t.Fatalf("图片块 = %+v", msg.Message.Content[1])
	}
	if msg.Message.Content[2].Type != "document" || msg.Message.Content[2].Source.MediaType != "application/pdf" {
		t.Fatalf("PDF 块 = %+v", msg.Message.Content[2])
	}
	if msg.Message.Content[3].Type != "text" || !strings.Contains(msg.Message.Content[3].Text, "hello") {
		t.Fatalf("文本文件块 = %+v", msg.Message.Content[3])
	}
}

// 子代理里的审批请求带 agent_id（实测没有 parent_tool_use_id），前端据此标归属。
func TestParsePermissionKeepsAgentID(t *testing.T) {
	line := []byte(`{"type":"control_request","request_id":"r1","request":{"subtype":"can_use_tool","tool_name":"Bash","input":{"command":"rm -rf /tmp/x"},"agent_id":"agent-42"}}`)
	env, err := Decode(line)
	if err != nil {
		t.Fatalf("Decode: %v", err)
	}
	p, ok := ParsePermission(env)
	if !ok {
		t.Fatal("应识别为 can_use_tool")
	}
	if p.AgentID != "agent-42" {
		t.Fatalf("AgentID = %q", p.AgentID)
	}
	if p.ToolName != "Bash" {
		t.Fatalf("ToolName = %q", p.ToolName)
	}
}

func TestPermissionModeOf(t *testing.T) {
	for _, tc := range []struct {
		name  string
		line  string
		want  string
		found bool
	}{
		{"status", `{"type":"system","subtype":"status","status":null,"permissionMode":"plan"}`, "plan", true},
		{"init", `{"type":"system","subtype":"init","permissionMode":"acceptEdits"}`, "acceptEdits", true},
		{"not system", `{"type":"assistant","permissionMode":"plan"}`, "", false},
		{"no mode", `{"type":"system","subtype":"init"}`, "", false},
		{"broken", `{`, "", false},
	} {
		got, ok := PermissionModeOf([]byte(tc.line))
		if ok != tc.found || got != tc.want {
			t.Fatalf("%s: PermissionModeOf = (%q,%v), want (%q,%v)", tc.name, got, ok, tc.want, tc.found)
		}
	}
}

// 投递语义字段：origin 决定 CLI 是否把消息算作「用户亲手打的」，
// priority=now 决定它能不能在当前回合被读到（而不是等本轮收尾）。
func TestUserMessagePromptOptions(t *testing.T) {
	decode := func(raw []byte) map[string]any {
		var m map[string]any
		if err := json.Unmarshal(raw, &m); err != nil {
			t.Fatalf("解析失败: %v", err)
		}
		return m
	}

	plain := decode(UserMessageWith("hi", nil, PromptOptions{}))
	if _, ok := plain["priority"]; ok {
		t.Fatalf("默认帧不该带 priority: %v", plain["priority"])
	}
	if _, ok := plain["origin"]; ok {
		t.Fatalf("默认帧不该带 origin: %v", plain["origin"])
	}

	human := decode(UserMessageWith("hi", nil, PromptOptions{Human: true}))
	origin, ok := human["origin"].(map[string]any)
	if !ok || origin["kind"] != "human" {
		t.Fatalf("origin = %v, want {kind:human}", human["origin"])
	}
	if _, ok := human["priority"]; ok {
		t.Fatalf("只标 human 时不该带 priority")
	}

	interject := decode(UserMessageWith("等一下", nil, PromptOptions{Priority: "now", Human: true}))
	if interject["priority"] != "now" {
		t.Fatalf("priority = %v, want now", interject["priority"])
	}
	if origin, _ := interject["origin"].(map[string]any); origin["kind"] != "human" {
		t.Fatalf("插话帧必须同时带 origin:human，实际 %v", interject["origin"])
	}
}

// TestIsTurnInit 只认 system/init：它是「一轮开始」的唯一信号（进程启动一次，
// 插话没赶上本轮时 CLI 会再发一次，会话据此把状态标回 busy）。
func TestIsTurnInit(t *testing.T) {
	for _, tc := range []struct {
		name string
		line string
		want bool
	}{
		{"init", `{"type":"system","subtype":"init","permissionMode":"default"}`, true},
		{"status", `{"type":"system","subtype":"status"}`, false},
		{"assistant", `{"type":"assistant","subtype":"init"}`, false},
		{"broken", `{`, false},
	} {
		if got := IsTurnInit([]byte(tc.line)); got != tc.want {
			t.Fatalf("%s: IsTurnInit = %v, want %v", tc.name, got, tc.want)
		}
	}
}

func TestInitPermissionMode(t *testing.T) {
	if got := InitPermissionMode([]byte(`{"claude_code_version":"2.1.325","current_permission_mode":"default"}`)); got != "default" {
		t.Fatalf("InitPermissionMode = %q", got)
	}
	// 字段名是 camelCase 的 system 消息不能当成 initialize 回包。
	if got := InitPermissionMode([]byte(`{"permissionMode":"plan"}`)); got != "" {
		t.Fatalf("不应读取 camelCase 字段，实际 %q", got)
	}
	if got := InitPermissionMode([]byte(`{`)); got != "" {
		t.Fatalf("坏 JSON 应返回空，实际 %q", got)
	}
}
