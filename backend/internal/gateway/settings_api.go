package gateway

import (
	"context"
	"encoding/json"
	"net/http"

	"ccweb/backend/internal/settings"
)

// handleGetSettings 返回脱敏后的配置（密钥不回传）。
func (s *Server) handleGetSettings(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, s.d.Settings.Public())
}

// handlePutSettings 局部更新配置。密钥字段留空表示「不修改」，
// 清除需要显式传 clear_api_key / clear_auth_token，避免误清空。
func (s *Server) handlePutSettings(w http.ResponseWriter, r *http.Request) {
	var patch settings.Patch
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10))
	if err := dec.Decode(&patch); err != nil {
		writeErr(w, "请求体解析失败: "+err.Error(), http.StatusBadRequest)
		return
	}
	pub, err := s.d.Settings.Apply(patch)
	if err != nil {
		writeErr(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, pub)
}

// handleTestSettings 用当前（已保存的）配置探测一次端点可用性。
// 只读取存储态，避免「改了没保存却以为测的是新值」。
func (s *Server) handleTestSettings(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), settings.ProbeTimeout)
	defer cancel()
	writeJSON(w, settings.Probe(ctx, s.d.Settings.Get()))
}
