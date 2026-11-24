package gateway

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"ccweb/backend/internal/history"
)

// handleHistorySubagent 返回一个子代理的对话回放。
//
// 子代理的转录不在主 jsonl 里（主转录没有 sidechain 行），必须按 agent id 读
// <project>/<session>/subagents/agent-<id>.jsonl 这条旁路。
func (s *Server) handleHistorySubagent(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimSpace(r.URL.Query().Get("id"))
	agent := strings.TrimSpace(r.URL.Query().Get("agent"))
	if id == "" || agent == "" {
		writeErr(w, "missing id or agent", http.StatusBadRequest)
		return
	}
	tr, err := history.LoadSubagentTranscript(s.d.HistoryDir, id, agent)
	if err != nil {
		if errors.Is(err, history.ErrTranscriptNotFound) {
			writeErr(w, err.Error(), http.StatusNotFound)
			return
		}
		writeErr(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, tr)
}

// handleSessionTask 控制会话里的任务：停止子代理 / 把前台任务转到后台。
//
// 走 HTTP 而不是 WS 上行命令：这是「对某个具体任务的一次动作」，不需要和消息流
// 共享顺序；失败也能直接回一个状态码。
func (s *Server) handleSessionTask(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID        string `json:"id"`
		Action    string `json:"action"`
		TaskID    string `json:"task_id"`
		ToolUseID string `json:"tool_use_id"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<10)).Decode(&req); err != nil {
		writeErr(w, "invalid json", http.StatusBadRequest)
		return
	}
	req.ID = strings.TrimSpace(req.ID)
	if req.ID == "" {
		writeErr(w, "missing id", http.StatusBadRequest)
		return
	}
	sess, ok := s.d.Manager.Get(req.ID)
	if !ok {
		// 进程已被空闲回收：没有可控制的任务，让前端提示重连。
		writeErr(w, "会话未在运行", http.StatusConflict)
		return
	}
	switch req.Action {
	case "stop":
		if strings.TrimSpace(req.TaskID) == "" {
			writeErr(w, "missing task_id", http.StatusBadRequest)
			return
		}
		if err := sess.StopTask(req.TaskID); err != nil {
			writeErr(w, err.Error(), http.StatusBadGateway)
			return
		}
	case "background":
		if err := sess.BackgroundTasks(req.ToolUseID); err != nil {
			writeErr(w, err.Error(), http.StatusBadGateway)
			return
		}
	default:
		writeErr(w, "unknown action", http.StatusBadRequest)
		return
	}
	writeJSON(w, map[string]any{"ok": true})
}

// handleSubagentUsage 返回本会话各子代理的累计消耗与收尾状态。
//
// 前端在一轮结束时拉一次：实时流里 CLI 只给「最后一次请求的上下文」，累计值必须
// 扫子代理转录。为了几个 token 数去重读整份主转录（几 MB）太重，这条只扫
// `subagents/` 目录（`subagentTotalTokens` 还按 mtime + size 缓存）。
func (s *Server) handleSubagentUsage(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimSpace(r.URL.Query().Get("id"))
	if id == "" {
		writeErr(w, "missing id", http.StatusBadRequest)
		return
	}
	states, err := history.LoadSubagentUsage(s.d.HistoryDir, id)
	if err != nil {
		if errors.Is(err, history.ErrTranscriptNotFound) {
			// 转录还没落盘（刚建的空对话）：没有子代理可报，不是错误。
			writeJSON(w, map[string]any{"subagents": []history.SubagentState{}})
			return
		}
		writeErr(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, map[string]any{"subagents": states})
}
