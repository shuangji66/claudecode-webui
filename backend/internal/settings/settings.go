// Package settings 是「第三方模型接入」的持久化配置。
//
// 设计（对齐 DSH 的模型页）：
//   - 用户按**协议**添加若干「提供商」：每个提供商有自己的 API 地址、密钥、
//     以及从它那里选中并添加的模型列表。
//   - 全局只有一个**当前选中模型**（provider + model）。它就是 claude CLI 的
//     「默认模型」——注入 ANTHROPIC_MODEL，CLI 始终以它为默认启动。
//   - 不再有 opus/sonnet/haiku 之类的别名槽位：别名映射那套已废弃。
//
// 所有持久化文件统一落在 CCWEB_DATA_DIR 下。
package settings

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

// DefaultAPIProtocol 是未指定协议时的默认值（Claude Code 走 Anthropic Messages）。
const DefaultAPIProtocol = "anthropic-messages"

// 支持的协议，与 DSH 的命名一致。
const (
	ProtocolAnthropic = "anthropic-messages"
	ProtocolOpenAI    = "openai-completions"
	ProtocolResponses = "openai-responses"
	ProtocolGemini    = "google-generative-ai"
)

// SupportedProtocols 是允许选择的协议。
var SupportedProtocols = []string{ProtocolAnthropic, ProtocolOpenAI, ProtocolResponses, ProtocolGemini}

// Provider 是一个第三方模型提供商。
type Provider struct {
	// ID 是小写唯一标识，用于稳定引用（改名不影响已选模型）。
	ID string `json:"id"`
	// Name 是显示名。
	Name string `json:"name"`
	// Protocol 决定「获取模型列表」时用哪种地址与鉴权。
	// 注意：对话始终走 Anthropic Messages（claude CLI 只支持这一种）。
	Protocol string `json:"protocol"`
	// BaseURL 是该提供商的基础地址，列表与对话都用它。
	BaseURL string `json:"base_url"`
	// APIKey 对应 x-api-key；对话时注入 ANTHROPIC_API_KEY。
	APIKey string `json:"api_key"`
	// AuthToken 是可选 Bearer 令牌；没有 APIKey 时注入 ANTHROPIC_AUTH_TOKEN。
	AuthToken string `json:"auth_token"`
	// ModelsPath 覆盖模型列表路径，留空按协议推导。
	ModelsPath string `json:"models_path"`
	// Models 是从该提供商处选中并添加的模型 ID。
	Models []string `json:"models"`
}

// Clone 返回深拷贝（切片不共享底层数组）。
func (p Provider) Clone() Provider {
	cp := p
	cp.Models = append([]string(nil), p.Models...)
	return cp
}

// Selection 是当前选中的模型，也是 CLI 的默认模型。
type Selection struct {
	Provider string `json:"provider"`
	Model    string `json:"model"`
}

// Settings 是全部可持久化配置。
type Settings struct {
	Providers []Provider `json:"providers"`
	Selected  Selection  `json:"selected"`

	PermissionMode            string `json:"permission_mode"`
	AutoCompactWindow         string `json:"auto_compact_window"`
	DisableUnknownModelWindow bool   `json:"disable_unknown_model_window"`

	// 以下字段已废弃，仅用于把旧配置迁移成 provider；迁移后会被清空。
	LegacyBaseURL   string `json:"base_url,omitempty"`
	LegacyAPIKey    string `json:"api_key,omitempty"`
	LegacyAuthToken string `json:"auth_token,omitempty"`
	LegacyProtocol  string `json:"api_protocol,omitempty"`
	LegacyModel     string `json:"model,omitempty"`
	LegacyOpus      string `json:"opus_model,omitempty"`
	LegacySonnet    string `json:"sonnet_model,omitempty"`
	LegacyHaiku     string `json:"haiku_model,omitempty"`
	LegacyPath      string `json:"models_path,omitempty"`
	LegacyKnown     string `json:"known_models,omitempty"`
}

// Public 是脱敏后的视图（密钥不回传）。
type Public struct {
	Providers []PublicProvider `json:"providers"`
	Selected  Selection        `json:"selected"`

	PermissionMode            string `json:"permission_mode"`
	AutoCompactWindow         string `json:"auto_compact_window"`
	DisableUnknownModelWindow bool   `json:"disable_unknown_model_window"`

	// Path 是配置文件路径，方便在 NAS 上备份。
	Path string `json:"path"`
}

// PublicProvider 是提供商的脱敏视图。
type PublicProvider struct {
	ID           string   `json:"id"`
	Name         string   `json:"name"`
	Protocol     string   `json:"protocol"`
	BaseURL      string   `json:"base_url"`
	APIKeySet    bool     `json:"api_key_set"`
	APIKeyMasked string   `json:"api_key_masked"`
	AuthTokenSet bool     `json:"auth_token_set"`
	ModelsPath   string   `json:"models_path"`
	Models       []string `json:"models"`
}

// ProviderPatch 是提交上来的提供商（密钥留空表示沿用已保存的）。
type ProviderPatch struct {
	ID         string   `json:"id"`
	Name       string   `json:"name"`
	Protocol   string   `json:"protocol"`
	BaseURL    string   `json:"base_url"`
	APIKey     string   `json:"api_key"`
	AuthToken  string   `json:"auth_token"`
	ClearKey   bool     `json:"clear_key"`
	ModelsPath string   `json:"models_path"`
	Models     []string `json:"models"`
}

// Patch 是局部更新请求。Providers 为 nil 表示不改；非 nil 则整体替换。
type Patch struct {
	Providers                 *[]ProviderPatch `json:"providers"`
	Selected                  *Selection       `json:"selected"`
	PermissionMode            *string          `json:"permission_mode"`
	AutoCompactWindow         *string          `json:"auto_compact_window"`
	DisableUnknownModelWindow *bool            `json:"disable_unknown_model_window"`
}

// Store 是带锁的内存态 + 磁盘持久化。
type Store struct {
	mu   sync.RWMutex
	path string
	cur  Settings
}

// Open 读取配置文件；文件不存在时返回空配置（不是错误）。
func Open(path string) (*Store, error) {
	s := &Store{path: path}
	b, err := os.ReadFile(path)
	switch {
	case err == nil:
		if err := json.Unmarshal(b, &s.cur); err != nil {
			return nil, fmt.Errorf("settings: 解析 %s: %w", path, err)
		}
		migrateLegacy(&s.cur)
	case errors.Is(err, os.ErrNotExist):
		// 首次启动，保持空配置
	default:
		return nil, fmt.Errorf("settings: 读取 %s: %w", path, err)
	}
	return s, nil
}

// migrateLegacy 把旧的「单端点 + 别名槽位」配置转成一个 provider。
//
// 老版本把地址/密钥平铺在顶层、模型分散在 4 个别名槽位里；新版统一成 providers。
// 迁移后清空旧字段，下次保存即写回新结构。
func migrateLegacy(s *Settings) {
	if len(s.Providers) > 0 {
		clearLegacy(s)
		return
	}
	if s.LegacyBaseURL == "" && s.LegacyAPIKey == "" && s.LegacyModel == "" {
		return
	}
	models := make([]string, 0, 4)
	for _, m := range []string{s.LegacyModel, s.LegacyOpus, s.LegacySonnet, s.LegacyHaiku} {
		m = strings.TrimSpace(m)
		if m == "" {
			continue
		}
		dup := false
		for _, x := range models {
			if x == m {
				dup = true
				break
			}
		}
		if !dup {
			models = append(models, m)
		}
	}
	proto := s.LegacyProtocol
	if proto == "" {
		proto = DefaultAPIProtocol
	}
	s.Providers = []Provider{{
		ID:         "default",
		Name:       "默认",
		Protocol:   proto,
		BaseURL:    s.LegacyBaseURL,
		APIKey:     s.LegacyAPIKey,
		AuthToken:  s.LegacyAuthToken,
		ModelsPath: s.LegacyPath,
		Models:     models,
	}}
	if s.Selected.Model == "" && len(models) > 0 {
		s.Selected = Selection{Provider: "default", Model: models[0]}
	}
	clearLegacy(s)
}

func clearLegacy(s *Settings) {
	s.LegacyBaseURL, s.LegacyAPIKey, s.LegacyAuthToken = "", "", ""
	s.LegacyProtocol, s.LegacyModel = "", ""
	s.LegacyOpus, s.LegacySonnet, s.LegacyHaiku = "", "", ""
	s.LegacyPath, s.LegacyKnown = "", ""
}

// Path 返回配置文件路径。
func (s *Store) Path() string { return s.path }

// Get 返回当前配置的副本。
func (s *Store) Get() Settings {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return cloneSettings(s.cur)
}

func cloneSettings(v Settings) Settings {
	out := v
	out.Providers = make([]Provider, len(v.Providers))
	for i, p := range v.Providers {
		out.Providers[i] = p.Clone()
	}
	return out
}

// Provider 按 id 查找提供商。
func (v Settings) Provider(id string) (Provider, bool) {
	for _, p := range v.Providers {
		if p.ID == id {
			return p, true
		}
	}
	return Provider{}, false
}

// Active 返回当前选中的提供商与模型；未选中或提供商不存在时 ok=false。
func (v Settings) Active() (Provider, string, bool) {
	if v.Selected.Provider == "" || v.Selected.Model == "" {
		return Provider{}, "", false
	}
	p, ok := v.Provider(v.Selected.Provider)
	if !ok {
		return Provider{}, "", false
	}
	for _, m := range p.Models {
		if m == v.Selected.Model {
			return p, m, true
		}
	}
	// 模型可能被从列表里移除，但当前选择仍指向它——仍然生效，避免会话凭空失效。
	return p, v.Selected.Model, true
}

// Env 返回注入 claude 子进程的环境变量。
//
// 关键点：把选中模型写进 ANTHROPIC_MODEL，CLI 因此「固定使用默认模型」；
// 选中提供商的地址与密钥决定请求打到哪。
func (v Settings) Env() []string {
	var out []string
	p, model, ok := v.Active()
	if ok {
		// 用 ChatBaseURL 而不是原始 base：OpenAI/Gemini 协议的地址带 /v1，
		// 直接喂给 CLI 会拼成 /v1/v1/messages。
		if base := p.ChatBaseURL(); base != "" {
			out = append(out, "ANTHROPIC_BASE_URL="+base)
		}
		// 对话始终走 Anthropic Messages：有 APIKey 就用 x-api-key，否则用 Bearer。
		if p.APIKey != "" {
			out = append(out, "ANTHROPIC_API_KEY="+p.APIKey)
		} else if p.AuthToken != "" {
			out = append(out, "ANTHROPIC_AUTH_TOKEN="+p.AuthToken)
		}
		out = append(out, "ANTHROPIC_MODEL="+model)
		// 关掉 CLI 内置的模型别名解析，避免它把网关模型名当成内置别名处理。
		out = append(out, "ANTHROPIC_DEFAULT_OPUS_MODEL="+model)
		out = append(out, "ANTHROPIC_DEFAULT_SONNET_MODEL="+model)
		out = append(out, "ANTHROPIC_DEFAULT_HAIKU_MODEL="+model)
	}
	if v.AutoCompactWindow != "" {
		out = append(out, "CLAUDE_CODE_AUTO_COMPACT_WINDOW="+v.AutoCompactWindow)
	}
	if v.DisableUnknownModelWindow {
		out = append(out, "CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT=1")
	}
	return out
}

// DefaultModel 返回当前选中模型（空表示未选，CLI 用自己的默认）。
func (v Settings) DefaultModel() string {
	_, model, ok := v.Active()
	if !ok {
		return ""
	}
	return model
}

// Public 返回脱敏视图。
func (s *Store) Public() Public {
	cur := s.Get()
	pub := Public{
		Providers:                 make([]PublicProvider, 0, len(cur.Providers)),
		Selected:                  cur.Selected,
		PermissionMode:            cur.PermissionMode,
		AutoCompactWindow:         cur.AutoCompactWindow,
		DisableUnknownModelWindow: cur.DisableUnknownModelWindow,
		Path:                      s.path,
	}
	for _, p := range cur.Providers {
		// 注意：append([]string(nil), 空切片...) 返回 nil，JSON 会序列化成 null，
		// 前端 p.models.map 会直接抛 TypeError 导致整页白屏。这里必须用非 nil 空切片。
		models := make([]string, 0, len(p.Models))
		models = append(models, p.Models...)
		pub.Providers = append(pub.Providers, PublicProvider{
			ID:           p.ID,
			Name:         p.Name,
			Protocol:     p.Protocol,
			BaseURL:      p.BaseURL,
			APIKeySet:    p.APIKey != "",
			APIKeyMasked: Mask(p.APIKey),
			AuthTokenSet: p.AuthToken != "",
			ModelsPath:   p.ModelsPath,
			Models:       models,
		})
	}
	return pub
}

// Apply 合并补丁、写盘并更新内存态。
func (s *Store) Apply(p Patch) (Public, error) {
	s.mu.Lock()
	next := cloneSettings(s.cur)

	if p.Providers != nil {
		merged, err := mergeProviders(s.cur.Providers, *p.Providers)
		if err != nil {
			s.mu.Unlock()
			return Public{}, err
		}
		next.Providers = merged
	}
	if p.Selected != nil {
		next.Selected = *p.Selected
	}
	if p.PermissionMode != nil {
		next.PermissionMode = strings.TrimSpace(*p.PermissionMode)
	}
	if p.AutoCompactWindow != nil {
		next.AutoCompactWindow = strings.TrimSpace(*p.AutoCompactWindow)
	}
	if p.DisableUnknownModelWindow != nil {
		next.DisableUnknownModelWindow = *p.DisableUnknownModelWindow
	}

	// 选中的提供商被删掉时清空选择，避免悬空引用。
	if next.Selected.Provider != "" {
		if _, ok := next.Provider(next.Selected.Provider); !ok {
			next.Selected = Selection{}
		}
	}

	if err := writeAtomic(s.path, next); err != nil {
		s.mu.Unlock()
		return Public{}, err
	}
	s.cur = next
	s.mu.Unlock()
	return s.Public(), nil
}

// mergeProviders 合并提交的提供商数组：密钥留空则沿用旧的。
func mergeProviders(old []Provider, in []ProviderPatch) ([]Provider, error) {
	oldByID := make(map[string]Provider, len(old))
	for _, p := range old {
		oldByID[p.ID] = p
	}

	out := make([]Provider, 0, len(in))
	seen := make(map[string]bool, len(in))
	for _, patch := range in {
		id := strings.TrimSpace(patch.ID)
		if id == "" {
			return nil, errors.New("settings: 提供商 ID 不能为空")
		}
		if seen[id] {
			return nil, fmt.Errorf("settings: 提供商 ID %q 重复", id)
		}
		seen[id] = true

		proto := strings.TrimSpace(patch.Protocol)
		if proto == "" {
			proto = DefaultAPIProtocol
		}
		prev, existed := oldByID[id]

		p := Provider{
			ID:         id,
			Name:       strings.TrimSpace(patch.Name),
			Protocol:   proto,
			BaseURL:    strings.TrimRight(strings.TrimSpace(patch.BaseURL), "/"),
			ModelsPath: strings.TrimSpace(patch.ModelsPath),
			Models:     dedupe(patch.Models),
		}
		if p.Name == "" {
			p.Name = id
		}

		// 密钥语义：空串=沿用旧值；ClearKey 才清空。
		switch {
		case patch.ClearKey:
			p.APIKey, p.AuthToken = "", ""
		default:
			p.APIKey = prev.APIKey
			p.AuthToken = prev.AuthToken
			if strings.TrimSpace(patch.APIKey) != "" {
				p.APIKey = strings.TrimSpace(patch.APIKey)
			}
			if strings.TrimSpace(patch.AuthToken) != "" {
				p.AuthToken = strings.TrimSpace(patch.AuthToken)
			}
		}
		_ = existed
		out = append(out, p)
	}
	return out, nil
}

func dedupe(in []string) []string {
	out := make([]string, 0, len(in))
	seen := make(map[string]bool, len(in))
	for _, v := range in {
		v = strings.TrimSpace(v)
		if v == "" || seen[v] {
			continue
		}
		seen[v] = true
		out = append(out, v)
	}
	return out
}

// writeAtomic 先写临时文件再 rename，避免半截文件；权限固定 0600。
func writeAtomic(path string, v Settings) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("settings: 创建目录 %s: %w", dir, err)
	}
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return fmt.Errorf("settings: 序列化: %w", err)
	}
	b = append(b, '\n')

	tmp, err := os.CreateTemp(dir, ".settings-*.json")
	if err != nil {
		return fmt.Errorf("settings: 创建临时文件: %w", err)
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)

	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return fmt.Errorf("settings: chmod: %w", err)
	}
	if _, err := tmp.Write(b); err != nil {
		tmp.Close()
		return fmt.Errorf("settings: 写入: %w", err)
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return fmt.Errorf("settings: fsync: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("settings: 关闭: %w", err)
	}
	if err := os.Rename(tmpName, path); err != nil {
		return fmt.Errorf("settings: 替换: %w", err)
	}
	return nil
}

// Mask 把密钥脱敏成「前缀…后缀」。
func Mask(secret string) string {
	if secret == "" {
		return ""
	}
	r := []rune(secret)
	switch {
	case len(r) <= 8:
		return strings.Repeat("•", len(r))
	case len(r) <= 16:
		return string(r[:2]) + strings.Repeat("•", 6) + string(r[len(r)-2:])
	default:
		return string(r[:6]) + strings.Repeat("•", 6) + string(r[len(r)-4:])
	}
}
