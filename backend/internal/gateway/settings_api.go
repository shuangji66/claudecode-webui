package gateway

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"

	"ccweb/backend/internal/settings"
)

// handleGetSettings 返回脱敏后的配置（密钥不回传）。
func (s *Server) handleGetSettings(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, s.d.Settings.Public())
}

// handlePutSettings 局部更新配置。
//
// 提供商数组是「整体替换」语义；其中某个提供商的密钥留空表示沿用已保存的值，
// 清除必须显式 clear_key——否则「只改模型列表」的保存会把密钥抹掉。
func (s *Server) handlePutSettings(w http.ResponseWriter, r *http.Request) {
	var patch settings.Patch
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 256<<10)).Decode(&patch); err != nil {
		writeErr(w, "请求体解析失败: "+err.Error(), http.StatusBadRequest)
		return
	}
	pub, err := s.d.Settings.Apply(patch)
	if err != nil {
		writeErr(w, err.Error(), http.StatusBadRequest)
		return
	}
	writeJSON(w, pub)
}

// providerRef 是「用存储里的 provider」或「用一组临时参数」的联合入参。
type providerRef struct {
	ProviderID string `json:"provider_id"`
	Protocol   string `json:"protocol"`
	BaseURL    string `json:"base_url"`
	APIKey     string `json:"api_key"`
	AuthToken  string `json:"auth_token"`
	ModelsPath string `json:"models_path"`
}

// resolve 返回要操作的 provider：优先用存储中的 id，否则用请求里的临时参数。
func (s *Server) resolve(ref providerRef) (settings.Provider, bool) {
	if ref.ProviderID != "" {
		if p, ok := s.d.Settings.Get().Provider(ref.ProviderID); ok {
			// 允许用未保存的地址/密钥/路径覆盖（表单还没保存时也能测）
			if ref.BaseURL != "" {
				p.BaseURL = ref.BaseURL
			}
			if ref.APIKey != "" {
				p.APIKey = ref.APIKey
			}
			if ref.AuthToken != "" {
				p.AuthToken = ref.AuthToken
			}
			if ref.ModelsPath != "" {
				p.ModelsPath = ref.ModelsPath
			}
			return p, true
		}
		return settings.Provider{}, false
	}
	return settings.Provider{
		ID:         "draft",
		Name:       "draft",
		Protocol:   ref.Protocol,
		BaseURL:    ref.BaseURL,
		APIKey:     ref.APIKey,
		AuthToken:  ref.AuthToken,
		ModelsPath: ref.ModelsPath,
	}, true
}

// handleFetchModels 拉取某个提供商的可用模型列表。
func (s *Server) handleFetchModels(w http.ResponseWriter, r *http.Request) {
	var ref providerRef
	if r.ContentLength > 0 {
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&ref); err != nil {
			writeErr(w, "请求体解析失败: "+err.Error(), http.StatusBadRequest)
			return
		}
	}
	p, ok := s.resolve(ref)
	if !ok {
		writeErr(w, "提供商不存在", http.StatusNotFound)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), settings.ProbeTimeout)
	defer cancel()
	writeJSON(w, settings.FetchModels(ctx, p))
}

type verifyModelReq struct {
	providerRef
	Model string `json:"model"`
}

// handleVerifyModel 验证单个模型名（用于手动录入时确认可用性）。
func (s *Server) handleVerifyModel(w http.ResponseWriter, r *http.Request) {
	var req verifyModelReq
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&req); err != nil {
		writeErr(w, "请求体解析失败: "+err.Error(), http.StatusBadRequest)
		return
	}
	p, ok := s.resolve(req.providerRef)
	if !ok {
		writeErr(w, "提供商不存在", http.StatusNotFound)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), settings.ProbeTimeout)
	defer cancel()
	writeJSON(w, settings.VerifyModel(ctx, p, req.Model))
}

// handleTestProvider 测试一个提供商的连通性。
func (s *Server) handleTestProvider(w http.ResponseWriter, r *http.Request) {
	var ref providerRef
	if r.ContentLength > 0 {
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&ref); err != nil {
			writeErr(w, "请求体解析失败: "+err.Error(), http.StatusBadRequest)
			return
		}
	}
	p, ok := s.resolve(ref)
	if !ok {
		writeErr(w, "提供商不存在", http.StatusNotFound)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), settings.ProbeTimeout)
	defer cancel()
	writeJSON(w, settings.Probe(ctx, p))
}

type proxyReq struct {
	ProxyURL string `json:"proxy_url"`
}

// handleApplyProxy 保存代理设置并重启全部 claude 会话。
//
// 代理变量只在进程启动时注入，改完必须换进程才能实时生效；这里先关掉
// 所有会话，再按原目录 ensure 一个新的。前端拿到响应里的 sessions 后
// 直接切换到新会话，不必等 WS 重连兜底。
func (s *Server) handleApplyProxy(w http.ResponseWriter, r *http.Request) {
	var req proxyReq
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&req); err != nil {
		writeErr(w, "请求体解析失败: "+err.Error(), http.StatusBadRequest)
		return
	}
	pub, err := s.d.Settings.Apply(settings.Patch{ProxyURL: &req.ProxyURL})
	if err != nil {
		writeErr(w, err.Error(), http.StatusBadRequest)
		return
	}

	infos := s.d.Manager.List()
	for _, info := range infos {
		_ = s.d.Manager.Close(info.ID)
	}
	warnings := make([]string, 0, 1)
	for _, info := range infos {
		if _, err := s.d.Manager.Ensure(info.Cwd, "", ""); err != nil {
			warnings = append(warnings, info.Cwd+": "+err.Error())
		}
	}
	writeJSON(w, map[string]any{
		"settings": pub,
		"sessions": s.d.Manager.List(),
		"warning":  strings.Join(warnings, "; "),
	})
}
