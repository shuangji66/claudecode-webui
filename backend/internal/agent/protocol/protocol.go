// Package protocol 描述 claude CLI 的 stream-json 双向协议。
//
// 协议形态（v2.1.x 实测）：
//   - 双方各以一行一个 JSON 对象（NDJSON）通信，stdin / stdout 各一条管道。
//   - 客户端必须先发 `control_request{initialize}`，否则 CLI 不产出任何消息。
//   - control_request 的 request_id 在**顶层**；control_response 的 request_id
//     嵌在 `response.request_id` 里，不在顶层。
//
// 本包只做编解码与消息构造，不关心进程与会话生命周期。
package protocol

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strings"
)

// 消息类型常量。
const (
	TypeControlRequest  = "control_request"
	TypeControlResponse = "control_response"
	TypeUser            = "user"
	TypeAssistant       = "assistant"
	TypeSystem          = "system"
	TypeResult          = "result"
	TypeStreamEvent     = "stream_event"
)

// 控制请求子类型。
const (
	SubtypeInitialize        = "initialize"
	SubtypeInterrupt         = "interrupt"
	SubtypeSetModel          = "set_model"
	SubtypeSetPermissionMode = "set_permission_mode"
	SubtypeCanUseTool        = "can_use_tool"
	// 任务控制：子代理 / 后台命令（2.1.325 实测有这两个控制请求）。
	SubtypeStopTask        = "stop_task"
	SubtypeBackgroundTasks = "background_tasks"
)

// InitializeRequestID 是初始化握手的固定 request_id，便于日志与排查。
const InitializeRequestID = "ccweb-init"

// Envelope 是一条已解析的协议消息。
type Envelope struct {
	Type    string
	Subtype string
	// RequestID 是 control_request 顶层的 request_id。
	RequestID string
	// RespRequestID 是 control_response.response.request_id。
	RespRequestID string
	// Raw 是原始 JSON，转发给前端时原样透传（未知字段不丢）。
	Raw json.RawMessage
}

type rawEnvelope struct {
	Type      string `json:"type"`
	Subtype   string `json:"subtype"`
	RequestID string `json:"request_id"`
	// control_request 的 subtype 嵌在 request.subtype 里，不在顶层。
	Request *struct {
		Subtype string `json:"subtype"`
	} `json:"request"`
	Response *struct {
		Subtype   string          `json:"subtype"`
		RequestID string          `json:"request_id"`
		Response  json.RawMessage `json:"response"`
	} `json:"response"`
}

// Decode 解析一行 NDJSON。
func Decode(line []byte) (Envelope, error) {
	var r rawEnvelope
	if err := json.Unmarshal(line, &r); err != nil {
		return Envelope{}, fmt.Errorf("protocol: decode envelope: %w", err)
	}
	env := Envelope{
		Type:      r.Type,
		Subtype:   r.Subtype,
		RequestID: r.RequestID,
		Raw:       append(json.RawMessage(nil), line...),
	}
	if r.Type == TypeControlRequest && r.Request != nil && r.Request.Subtype != "" {
		env.Subtype = r.Request.Subtype
	}
	if r.Response != nil {
		env.RespRequestID = r.Response.RequestID
		if env.Subtype == "" {
			env.Subtype = r.Response.Subtype
		}
	}
	return env, nil
}

// ResponseError 取出 control_response 的 error 子类型里的错误文本。
//
// CLI 拒绝一个控制请求时回的是
// `{"type":"control_response","response":{"subtype":"error","request_id":"r1","error":"..."}}`，
// 此时 `response.response` 是空的；只看载荷会把失败当成成功。
func (e Envelope) ResponseError() string {
	var r struct {
		Response *struct {
			Error string `json:"error"`
		} `json:"response"`
	}
	if err := json.Unmarshal(e.Raw, &r); err != nil || r.Response == nil {
		return ""
	}
	return strings.TrimSpace(r.Response.Error)
}

// ResponsePayload 取出 control_response 里 `response.response` 的载荷。
// 结构形如：
//
//	{"type":"control_response","response":{"subtype":"success","request_id":"r1","response":{...}}}
func (e Envelope) ResponsePayload() json.RawMessage {
	var r rawEnvelope
	if err := json.Unmarshal(e.Raw, &r); err != nil || r.Response == nil {
		return nil
	}
	return r.Response.Response
}

// --- 客户端 → CLI 的消息构造 ---

// Initialize 构造初始化控制请求。必须在进程启动后立刻发送。
func Initialize(requestID string) []byte {
	if requestID == "" {
		requestID = InitializeRequestID
	}
	return mustMarshal(map[string]any{
		"type":       TypeControlRequest,
		"request_id": requestID,
		"request": map[string]any{
			"subtype": SubtypeInitialize,
			"hooks":   nil,
			"agents":  nil,
		},
	})
}

// Attachment 是一条随用户消息发送的文件。
type Attachment struct {
	Name      string
	MediaType string
	Data      []byte
}

// UserText 构造一条纯文本用户消息。
func UserText(text string) []byte {
	return UserMessage(text, nil)
}

// UserMessage 构造带附件的用户消息。
//
// 图片走 Anthropic 的 image content block，PDF 走 document block；
// 文本文件在服务端解码后作为 text block 附在提示词后面。这样 CLI 与
// 上游 API 都按原生多模态消息处理，不需要把文件塞进 JSON 字符串。
func UserMessage(text string, attachments []Attachment) []byte {
	content := make([]map[string]any, 0, len(attachments)+1)
	if text != "" {
		content = append(content, map[string]any{"type": "text", "text": text})
	}
	for _, a := range attachments {
		mediaType := strings.ToLower(strings.TrimSpace(a.MediaType))
		switch {
		case strings.HasPrefix(mediaType, "image/"):
			content = append(content, map[string]any{
				"type": "image",
				"source": map[string]any{
					"type":       "base64",
					"media_type": mediaType,
					"data":       base64.StdEncoding.EncodeToString(a.Data),
				},
			})
		case mediaType == "application/pdf":
			content = append(content, map[string]any{
				"type": "document",
				"source": map[string]any{
					"type":       "base64",
					"media_type": mediaType,
					"data":       base64.StdEncoding.EncodeToString(a.Data),
				},
			})
		default:
			name := strings.NewReplacer("\"", "'", "\n", " ", "\r", " ").Replace(a.Name)
			content = append(content, map[string]any{
				"type": "text",
				"text": fmt.Sprintf("<file name=%q>\n%s\n</file>", name, string(a.Data)),
			})
		}
	}
	if len(content) == 0 {
		content = append(content, map[string]any{"type": "text", "text": text})
	}
	return mustMarshal(map[string]any{
		"type":       TypeUser,
		"session_id": nil,
		"message": map[string]any{
			"role":    "user",
			"content": content,
		},
		"parent_tool_use_id": nil,
	})
}

// ControlRequest 构造一个无参控制请求（interrupt 等）。
func ControlRequest(requestID, subtype string) []byte {
	return mustMarshal(map[string]any{
		"type":       TypeControlRequest,
		"request_id": requestID,
		"request":    map[string]any{"subtype": subtype},
	})
}

// SetModel 构造切换模型的控制请求。
func SetModel(requestID, model string) []byte {
	return mustMarshal(map[string]any{
		"type":       TypeControlRequest,
		"request_id": requestID,
		"request":    map[string]any{"subtype": SubtypeSetModel, "model": model},
	})
}

// InitPermissionMode 从 initialize 回包里取会话启动时的权限模式。
//
// 字段名与 system 消息不同：initialize 回包是 snake_case 的
// current_permission_mode，system/status 与 system/init 是 camelCase 的 permissionMode。
func InitPermissionMode(payload []byte) string {
	var init struct {
		CurrentPermissionMode string `json:"current_permission_mode"`
	}
	if err := json.Unmarshal(payload, &init); err != nil {
		return ""
	}
	return init.CurrentPermissionMode
}

// PermissionModeOf 从 CLI 的 system 消息里取当前权限模式。
//
// 两个来源都带这个字段：切模式回包之后的 system/status，以及每个回合的
// system/init。界面上的「当前模式」以它为准，不要自己记一份可能过期的状态。
func PermissionModeOf(raw []byte) (string, bool) {
	var msg struct {
		Type           string `json:"type"`
		PermissionMode string `json:"permissionMode"`
	}
	if err := json.Unmarshal(raw, &msg); err != nil {
		return "", false
	}
	if msg.Type != TypeSystem || msg.PermissionMode == "" {
		return "", false
	}
	return msg.PermissionMode, true
}

// SetPermissionMode 构造切换权限模式的控制请求。
func SetPermissionMode(requestID, mode string) []byte {
	return mustMarshal(map[string]any{
		"type":       TypeControlRequest,
		"request_id": requestID,
		"request":    map[string]any{"subtype": SubtypeSetPermissionMode, "mode": mode},
	})
}

// Allow 回包：允许本次工具调用。updatedInput 为空则使用原始输入。
func Allow(requestID string, updatedInput json.RawMessage) []byte {
	return AllowWith(requestID, updatedInput, nil)
}

// AllowWith 回包：允许本次调用，并可附带 updatedPermissions（把规则/模式写回设置）。
// updatedPermissions 来自 permission_suggestions 里的 addRules / setMode 项，
// 直接透传即可；这是前端「始终允许」「切到自动编辑」两个按钮的实现基础。
func AllowWith(requestID string, updatedInput, updatedPermissions json.RawMessage) []byte {
	resp := map[string]any{"behavior": "allow"}
	if len(updatedInput) > 0 {
		resp["updatedInput"] = updatedInput
	}
	if len(updatedPermissions) > 0 {
		resp["updatedPermissions"] = updatedPermissions
	}
	return controlResponse(requestID, resp)
}

// Deny 回包：拒绝本次工具调用，message 会作为拒绝理由回给模型。
func Deny(requestID, message string) []byte {
	resp := map[string]any{"behavior": "deny"}
	if message != "" {
		resp["message"] = message
	}
	return controlResponse(requestID, resp)
}

// Unsupported 回包：对不认识的子类型统一回错，让 CLI 自行降级而不是干等。
func Unsupported(requestID string) []byte {
	return mustMarshal(map[string]any{
		"type": "control_response",
		"response": map[string]any{
			"subtype":    "error",
			"request_id": requestID,
			"error":      "unsupported control request subtype",
			"error_code": "unsupported_request",
		},
	})
}

func controlResponse(requestID string, payload map[string]any) []byte {
	return mustMarshal(map[string]any{
		"type": "control_response",
		"response": map[string]any{
			"subtype":    "success",
			"request_id": requestID,
			"response":   payload,
		},
	})
}

func mustMarshal(v any) []byte {
	b, err := json.Marshal(v)
	if err != nil {
		// 这里的输入全部是 map[string]any / 字符串，不会失败；真失败了也没有可恢复路径。
		panic("protocol: marshal: " + err.Error())
	}
	return b
}

// PermissionRequest 是 can_use_tool 控制请求的载荷。
type PermissionRequest struct {
	RequestID   string          `json:"request_id"`
	Subtype     string          `json:"subtype"`
	ToolName    string          `json:"tool_name"`
	DisplayName string          `json:"display_name"`
	Description string          `json:"description"`
	Input       json.RawMessage `json:"input"`
	BlockedPath string          `json:"blocked_path"`
	ToolUseID   string          `json:"tool_use_id"`
	// AgentID 非空表示这次调用发生在子代理内部（实测 2.1.325 带 agent_id，不带 parent_tool_use_id）。
	AgentID string `json:"agent_id"`
	// PermissionSuggestions 原样透传给前端，由前端渲染成「始终允许 / 切模式」等按钮。
	PermissionSuggestions json.RawMessage `json:"permission_suggestions"`
}

// ParsePermission 从 control_request 中解析 can_use_tool 载荷。
func ParsePermission(env Envelope) (PermissionRequest, bool) {
	if env.Type != TypeControlRequest {
		return PermissionRequest{}, false
	}
	var wrapper struct {
		Request PermissionRequest `json:"request"`
	}
	if err := json.Unmarshal(env.Raw, &wrapper); err != nil {
		return PermissionRequest{}, false
	}
	p := wrapper.Request
	if p.Subtype != SubtypeCanUseTool {
		return PermissionRequest{}, false
	}
	p.RequestID = env.RequestID
	return p, true
}

// StopTask 构造停止一个后台任务的控制请求（子代理、后台命令都用 task_id）。
func StopTask(requestID, taskID string) []byte {
	return mustMarshal(map[string]any{
		"type":       TypeControlRequest,
		"request_id": requestID,
		"request": map[string]any{
			"subtype": SubtypeStopTask,
			"task_id": taskID,
		},
	})
}

// BackgroundTasks 构造「转到后台」的控制请求。
//
// toolUseID 为空时针对全部前台任务（等价 Ctrl+B），否则只转那一个。
func BackgroundTasks(requestID, toolUseID string) []byte {
	req := map[string]any{"subtype": SubtypeBackgroundTasks}
	if toolUseID != "" {
		req["tool_use_id"] = toolUseID
	}
	return mustMarshal(map[string]any{
		"type":       TypeControlRequest,
		"request_id": requestID,
		"request":    req,
	})
}
