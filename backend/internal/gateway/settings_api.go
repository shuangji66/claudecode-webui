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

// fetchModelsReq 允许用「尚未保存」的地址/密钥先拉一次列表。
// 密钥留空则沿用已保存的值（与保存语义一致）。
type fetchModelsReq struct {
	BaseURL     string `json:"base_url"`
	APIKey      string `json:"api_key"`
	ModelsPath  string `json:"models_path"`
	APIProtocol string `json:"api_protocol"`
}

// handleFetchModels 从网关拉取可用模型列表，供设置页把网关模型挂到内置别名上。
func (s *Server) handleFetchModels(w http.ResponseWriter, r *http.Request) {
	var req fetchModelsReq
	if r.ContentLength > 0 {
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&req); err != nil {
			writeErr(w, "请求体解析失败: "+err.Error(), http.StatusBadRequest)
			return
		}
	}
	// 以存储态为底，再用请求里填的值覆盖（空值不覆盖）。
	v := s.d.Settings.Get()
	if req.BaseURL != "" {
		v.BaseURL = req.BaseURL
	}
	if req.APIKey != "" {
		v.APIKey = req.APIKey
	}
	// models_path 用指针无法区分「没传」与「传空」，这里用非空覆盖即可：
	// 想回到自动探测，用户清空后先保存一次，再点获取。
	if req.ModelsPath != "" {
		v.ModelsPath = req.ModelsPath
	}
	if req.APIProtocol != "" {
		v.APIProtocol = req.APIProtocol
	}

	ctx, cancel := context.WithTimeout(r.Context(), settings.ProbeTimeout)
	defer cancel()
	writeJSON(w, settings.FetchModels(ctx, v))
}

type verifyModelReq struct {
	Model string `json:"model"`
}

// handleVerifyModel 验证单个模型名（用于网关没有 /v1/models 时手工确认）。
func (s *Server) handleVerifyModel(w http.ResponseWriter, r *http.Request) {
	var req verifyModelReq
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<10)).Decode(&req); err != nil {
		writeErr(w, "请求体解析失败: "+err.Error(), http.StatusBadRequest)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), settings.ProbeTimeout)
	defer cancel()
	writeJSON(w, settings.VerifyModel(ctx, s.d.Settings.Get(), req.Model))
}
