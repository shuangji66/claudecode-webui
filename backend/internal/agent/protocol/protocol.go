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
	"encoding/json"
	"fmt"
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

// UserText 构造一条用户文本消息。
func UserText(text string) []byte {
	return mustMarshal(map[string]any{
		"type":       TypeUser,
		"session_id": nil,
		"message": map[string]any{
			"role":    "user",
			"content": []map[string]any{{"type": "text", "text": text}},
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
