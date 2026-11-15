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

// 界面偏好的默认值与允许范围。主题与语言都落在服务端，换设备也能保持一致。
const (
	DefaultTheme    = "system"
	DefaultLocale   = "zh"
	DefaultFontSize = 15
	MinFontSize     = 12
	MaxFontSize     = 20
)

// SupportedThemes / SupportedLocales / SupportedEfforts 是配置校验白名单。
var (
	SupportedThemes  = []string{"system", "light", "dark"}
	SupportedLocales = []string{"zh", "en"}
	SupportedEfforts = []string{"low", "medium", "high", "xhigh", "max"}
)

// ModelSpec 是某个模型的展示与能力元数据，按模型 ID 存在 Provider.ModelMeta 里。
// 模型 ID 列表仍是 Provider.Models，保持与旧配置 / 网关列表兼容。
type ModelSpec struct {
	// Name 是显示名，留空用模型 ID。
	Name string `json:"name,omitempty"`
	// ReasoningEfforts 是该模型支持的推理强度；为空表示不暴露强度选择。
	ReasoningEfforts []string `json:"reasoning_efforts,omitempty"`
	// DefaultReasoningEffort 是新建会话时的默认强度，必须在 ReasoningEfforts 内。
	DefaultReasoningEffort string `json:"default_reasoning_effort,omitempty"`
	// SupportsImage 表示模型接受图片输入（仅影响界面提示与能力标记）。
	SupportsImage bool `json:"supports_image,omitempty"`
}

func (m ModelSpec) Clone() ModelSpec {
	m.ReasoningEfforts = append([]string(nil), m.ReasoningEfforts...)
	return m
}

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
	// ModelMeta 按模型 ID 记录显示名、推理强度与图片能力。
	ModelMeta map[string]ModelSpec `json:"model_meta,omitempty"`
}

// Clone 返回深拷贝（切片不共享底层数组）。
func (p Provider) Clone() Provider {
	cp := p
	cp.Models = append([]string(nil), p.Models...)
	cp.ModelMeta = make(map[string]ModelSpec, len(p.ModelMeta))
	for k, v := range p.ModelMeta {
		cp.ModelMeta[k] = v.Clone()
	}
	return cp
}

// Selection 是当前选中的模型，也是 CLI 的默认模型。
type Selection struct {
	Provider string `json:"provider"`
	Model    string `json:"model"`
	// Effort 是选中的推理强度；为空时用模型默认值。
	Effort string `json:"effort,omitempty"`
}

// Settings 是全部可持久化配置。
type Settings struct {
	Providers []Provider `json:"providers"`
	Selected  Selection  `json:"selected"`

	PermissionMode            string `json:"permission_mode"`
	AutoCompactWindow         string `json:"auto_compact_window"`
	DisableUnknownModelWindow bool   `json:"disable_unknown_model_window"`

	// 界面偏好（服务端持久化，所有设备共享）。
	Theme    string `json:"theme"`
	Locale   string `json:"locale"`
	FontSize int    `json:"font_size"`

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

	Theme    string `json:"theme"`
	Locale   string `json:"locale"`
	FontSize int    `json:"font_size"`

	// Path 是配置文件路径，方便在 NAS 上备份。
	Path string `json:"path"`
}

// PublicProvider 是提供商的脱敏视图。
type PublicProvider struct {
	ID           string               `json:"id"`
	Name         string               `json:"name"`
	Protocol     string               `json:"protocol"`
	BaseURL      string               `json:"base_url"`
	APIKeySet    bool                 `json:"api_key_set"`
	APIKeyMasked string               `json:"api_key_masked"`
	AuthTokenSet bool                 `json:"auth_token_set"`
	ModelsPath   string               `json:"models_path"`
	Models       []string             `json:"models"`
	ModelMeta    map[string]ModelSpec `json:"model_meta"`
}

// ProviderPatch 是提交上来的提供商（密钥留空表示沿用已保存的）。
type ProviderPatch struct {
	ID         string               `json:"id"`
	Name       string               `json:"name"`
	Protocol   string               `json:"protocol"`
	BaseURL    string               `json:"base_url"`
	APIKey     string               `json:"api_key"`
	AuthToken  string               `json:"auth_token"`
	ClearKey   bool                 `json:"clear_key"`
	ModelsPath string               `json:"models_path"`
	Models     []string             `json:"models"`
	ModelMeta  map[string]ModelSpec `json:"model_meta"`
}

// Patch 是局部更新请求。Providers 为 nil 表示不改；非 nil 则整体替换。
type Patch struct {
	Providers                 *[]ProviderPatch `json:"providers"`
	Selected                  *Selection       `json:"selected"`
	PermissionMode            *string          `json:"permission_mode"`
	AutoCompactWindow         *string          `json:"auto_compact_window"`
	DisableUnknownModelWindow *bool            `json:"disable_unknown_model_window"`
	Theme                     *string          `json:"theme"`
	Locale                    *string          `json:"locale"`
	FontSize                  *int             `json:"font_size"`
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
		// 首次启动，保持空 provider；界面偏好仍要给默认值
	default:
		return nil, fmt.Errorf("settings: 读取 %s: %w", path, err)
	}
	normalizePreferences(&s.cur)
	return s, nil
}

// normalizePreferences 给老配置补上界面偏好默认值。
func normalizePreferences(v *Settings) {
	if !containsString(SupportedThemes, v.Theme) {
		v.Theme = DefaultTheme
	}
	if !containsString(SupportedLocales, v.Locale) {
		v.Locale = DefaultLocale
	}
	if v.FontSize < MinFontSize || v.FontSize > MaxFontSize {
		v.FontSize = DefaultFontSize
	}
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

// Active 返回当前选中的提供商与模型 ID；未选中或提供商不存在时 ok=false。
func (v Settings) Active() (Provider, string, bool) {
	p, model, _, ok := v.ActiveModel()
	return p, model, ok
}

// ActiveModel 返回当前选中的提供商、模型 ID 与元数据。
// 模型被从列表移除时仍视为有效（模型 ID 可以直接发），元数据用空默认值。
func (v Settings) ActiveModel() (Provider, string, ModelSpec, bool) {
	if v.Selected.Provider == "" || v.Selected.Model == "" {
		return Provider{}, "", ModelSpec{}, false
	}
	p, ok := v.Provider(v.Selected.Provider)
	if !ok {
		return Provider{}, "", ModelSpec{}, false
	}
	spec := p.ModelMeta[v.Selected.Model].Clone()
	if spec.Name == "" {
		spec.Name = v.Selected.Model
	}
	return p, v.Selected.Model, spec, true
}

// DefaultEffort 返回新建会话应使用的推理强度；模型未声明强度时为空。
func (v Settings) DefaultEffort() string {
	_, _, spec, ok := v.ActiveModel()
	if !ok || len(spec.ReasoningEfforts) == 0 {
		return ""
	}
	if containsString(spec.ReasoningEfforts, v.Selected.Effort) {
		return v.Selected.Effort
	}
	if containsString(spec.ReasoningEfforts, spec.DefaultReasoningEffort) {
		return spec.DefaultReasoningEffort
	}
	return spec.ReasoningEfforts[0]
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
		Theme:                     cur.Theme,
		Locale:                    cur.Locale,
		FontSize:                  cur.FontSize,
		Path:                      s.path,
	}
	for _, p := range cur.Providers {
		// 注意：append([]string(nil), 空切片...) 返回 nil，JSON 会序列化成 null，
		// 前端 p.models.map 会直接抛 TypeError 导致整页白屏。这里必须用非 nil 空切片。
		models := make([]string, 0, len(p.Models))
		models = append(models, p.Models...)
		meta := make(map[string]ModelSpec, len(p.ModelMeta))
		for k, v := range p.ModelMeta {
			meta[k] = v.Clone()
		}
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
			ModelMeta:    meta,
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
	if p.Theme != nil {
		theme := strings.TrimSpace(*p.Theme)
		if !containsString(SupportedThemes, theme) {
			s.mu.Unlock()
			return Public{}, fmt.Errorf("settings: 不支持的主题 %q", theme)
		}
		next.Theme = theme
	}
	if p.Locale != nil {
		locale := strings.TrimSpace(*p.Locale)
		if !containsString(SupportedLocales, locale) {
			s.mu.Unlock()
			return Public{}, fmt.Errorf("settings: 不支持的语言 %q", locale)
		}
		next.Locale = locale
	}
	if p.FontSize != nil {
		if *p.FontSize < MinFontSize || *p.FontSize > MaxFontSize {
			s.mu.Unlock()
			return Public{}, fmt.Errorf("settings: 字号必须在 %d–%d px 之间", MinFontSize, MaxFontSize)
		}
		next.FontSize = *p.FontSize
	}

	// 选中的提供商被删掉时清空选择，避免悬空引用。
	if next.Selected.Provider != "" {
		p, ok := next.Provider(next.Selected.Provider)
		if !ok {
			next.Selected = Selection{}
		} else if next.Selected.Model != "" {
			spec := p.ModelMeta[next.Selected.Model]
			if len(spec.ReasoningEfforts) == 0 {
				next.Selected.Effort = ""
			} else if !containsString(spec.ReasoningEfforts, next.Selected.Effort) {
				next.Selected.Effort = spec.DefaultReasoningEffort
			}
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

		models := dedupe(patch.Models)
		p := Provider{
			ID:         id,
			Name:       strings.TrimSpace(patch.Name),
			Protocol:   proto,
			BaseURL:    strings.TrimRight(strings.TrimSpace(patch.BaseURL), "/"),
			ModelsPath: strings.TrimSpace(patch.ModelsPath),
			Models:     models,
			ModelMeta:  normalizeModelMeta(models, patch.ModelMeta),
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

// normalizeModelMeta 只保留仍存在的模型 ID，并修正强度列表/默认值。
func normalizeModelMeta(models []string, in map[string]ModelSpec) map[string]ModelSpec {
	out := make(map[string]ModelSpec, len(models))
	for _, id := range models {
		spec, ok := in[id]
		if !ok {
			continue
		}
		spec.Name = strings.TrimSpace(spec.Name)
		efforts := make([]string, 0, len(spec.ReasoningEfforts))
		seen := make(map[string]bool)
		for _, e := range spec.ReasoningEfforts {
			e = strings.TrimSpace(e)
			if e == "" || seen[e] || !containsString(SupportedEfforts, e) {
				continue
			}
			seen[e] = true
			efforts = append(efforts, e)
		}
		spec.ReasoningEfforts = efforts
		if len(efforts) == 0 {
			spec.DefaultReasoningEffort = ""
		} else if !containsString(efforts, spec.DefaultReasoningEffort) {
			spec.DefaultReasoningEffort = efforts[0]
		}
		out[id] = spec
	}
	return out
}

func containsString(list []string, v string) bool {
	for _, x := range list {
		if x == v {
			return true
		}
	}
	return false
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
