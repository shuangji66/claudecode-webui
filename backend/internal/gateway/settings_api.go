package gateway

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"ccweb/backend/internal/authz"
	"ccweb/backend/internal/history"
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
//
// TCP 端口/开关不一样：它们是监听状态，必须**先 bind 成功再落盘**。否则开关
// 写进 settings.json 却监听失败，下次启动还是坏的，用户也不知道该改哪里。
func (s *Server) handlePutSettings(w http.ResponseWriter, r *http.Request) {
	var patch settings.Patch
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 256<<10)).Decode(&patch); err != nil {
		writeErr(w, "请求体解析失败: "+err.Error(), http.StatusBadRequest)
		return
	}

	// 只有请求真的碰了 TCP 设置才动监听：其它页面的保存不该因为
	// 「上次端口没绑上」被连带报错。Access 页每次都会带上这两个字段，
	// 所以它按保存键本身就能重试失败的监听。
	//
	// 串行化整段「监听调整 + 落盘」：两个标签页同时保存时，监听和
	// settings.json 不能各自保留不同请求的结果。
	touchingTCP := patch.TCPEnabled != nil || patch.TCPPort != nil
	if touchingTCP {
		s.tcpOpMu.Lock()
		defer s.tcpOpMu.Unlock()
	}

	prevPort, prevListening, _ := s.TCPStatus()
	listened := false
	disabling := false

	if touchingTCP {
		cur := s.d.Settings.Get()
		enabled := cur.TCPEnabled
		if patch.TCPEnabled != nil {
			enabled = *patch.TCPEnabled
		}
		port := cur.TCPPort
		if patch.TCPPort != nil {
			port = *patch.TCPPort
		}
		if !settings.ValidTCPPort(port) {
			writeErr(w, fmt.Sprintf("TCP 端口必须在 %d–%d 之间", settings.MinTCPPort, settings.MaxTCPPort), http.StatusBadRequest)
			return
		}
		// 密码与开关在同一个补丁里时以补丁为准（Apply 里还会真正哈希）。
		hasPassword := cur.TCPPasswordHash != ""
		if patch.TCPPassword != nil && *patch.TCPPassword != "" {
			if err := authz.ValidatePassword(*patch.TCPPassword); err != nil {
				writeErr(w, "访问密码不符合要求："+err.Error(), http.StatusBadRequest)
				return
			}
			hasPassword = true
		}
		if enabled && !hasPassword {
			writeErr(w, "开启端口访问前请先设置访问密码", http.StatusBadRequest)
			return
		}
		if enabled {
			if !prevListening || prevPort != port {
				if err := s.ListenTCP(port); err != nil {
					// 保存前真的 bind 一次：端口被别的程序占用时直接 400，
					// 设置不落盘、旧监听也不受影响。
					writeErr(w, "TCP 端口无法监听（可能已被其它程序占用）："+err.Error(), http.StatusBadRequest)
					return
				}
				listened = true
			}
		} else {
			// 关闭端口访问：落盘成功后才真正断开（见下面）。
			disabling = true
		}
	}

	pub, err := s.d.Settings.Apply(patch)
	if err != nil {
		if listened {
			if prevListening && prevPort > 0 {
				_ = s.ListenTCP(prevPort)
			} else {
				s.CloseTCP()
			}
		}
		writeErr(w, err.Error(), http.StatusBadRequest)
		return
	}

	if disabling {
		// 会话立刻作废；listener 也马上关掉（端口可立刻重开），
		// 已有连接再活 500ms——足够让「保存成功」的响应送出去。
		// 先摘状态再延迟关旧 server，能避免「关掉后立刻重开」被误杀。
		s.d.Guard.ClearSessions()
		if prevListening {
			s.StopTCPGracefully(500 * time.Millisecond)
		}
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
		// 用 resume 保持对话 id 不变。只有「还没有转录的空对话」才允许退回 ensure：
		// 有转录的对话 Resume 失败必须如实报 warning，不能换一个新 uuid —— 那等于
		// 把用户的上下文整段丢掉，而前端 active id 仍指向旧对话。
		if _, err := s.d.Manager.Resume(info.ID, info.Cwd, info.Model, ""); err != nil {
			if s.d.HistoryDir != "" && history.SessionLogExists(s.d.HistoryDir, info.ID) {
				warnings = append(warnings, info.Cwd+": "+err.Error())
				continue
			}
			if _, err2 := s.d.Manager.Ensure(info.Cwd, "", ""); err2 != nil {
				warnings = append(warnings, info.Cwd+": "+err2.Error())
			}
		}
	}
	writeJSON(w, map[string]any{
		"settings": pub,
		"sessions": s.d.Manager.List(),
		"warning":  strings.Join(warnings, "; "),
	})
}
