// Package settings 负责「第三方模型接入」等可持久化配置。
//
// 设计要点：
//   - 所有持久化文件统一落在 CCWEB_DATA_DIR 下，这里只认一个文件路径；
//   - 写盘用 tmp + rename 的原子替换，权限 0600（文件里有密钥）；
//   - 对外只暴露脱敏视图，密钥永远不回传前端；
//   - 配置以环境变量形式注入 claude 子进程（ANTHROPIC_* 系列），
//     因此**只对新建会话生效**，已在跑的进程无法改变环境。
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

// Settings 是全部可持久化配置。
type Settings struct {
	// BaseURL 是 Anthropic 兼容端点（ANTHROPIC_BASE_URL）。空 = 官方地址。
	BaseURL string `json:"base_url"`
	// APIKey 对应 ANTHROPIC_API_KEY（x-api-key 头）。
	APIKey string `json:"api_key"`
	// AuthToken 对应 ANTHROPIC_AUTH_TOKEN（Authorization: Bearer）。
	AuthToken string `json:"auth_token"`

	// Model 是默认模型（ANTHROPIC_MODEL）。
	Model string `json:"model"`
	// 以下三个是别名映射（ANTHROPIC_DEFAULT_*_MODEL）。
	OpusModel   string `json:"opus_model"`
	SonnetModel string `json:"sonnet_model"`
	HaikuModel  string `json:"haiku_model"`

	// PermissionMode 是新会话的默认权限模式。
	PermissionMode string `json:"permission_mode"`

	// AutoCompactWindow 对应 CLAUDE_CODE_AUTO_COMPACT_WINDOW（如 "200k"）。
	// 自定义模型没有内置窗口元数据，CLI 会默认按 1M 估算，这里可以纠正。
	AutoCompactWindow string `json:"auto_compact_window"`
	// DisableUnknownModelWindow 关闭 CLI 对未知模型窗口的推断。
	// 对应 CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT=1。
	DisableUnknownModelWindow bool `json:"disable_unknown_model_window"`

	// ModelsPath 是拉取模型列表的路径（如 /api/models）。
	// 留空表示自动探测。不同中转的实现路径差异极大，必须允许手填。
	ModelsPath string `json:"models_path"`

	// ManualModels 是手动导入的模型名（每行一个），用于网关没有任何列表接口时
	// 仍能获得下拉补全。与自动拉取的结果在前端合并。
	ManualModels string `json:"manual_models"`

	// APIProtocol 决定「获取可用模型」按哪种协议探测与鉴权：
	// anthropic-messages / openai-completions / openai-responses / google-generative-ai。
	APIProtocol string `json:"api_protocol"`

	// KnownModels 是用户采纳过的模型名（每行一个），供下拉补全使用。
	KnownModels string `json:"known_models"`
}

// Public 是脱敏后的视图，用于回传前端。
type Public struct {
	BaseURL                   string `json:"base_url"`
	APIKeySet                 bool   `json:"api_key_set"`
	APIKeyMasked              string `json:"api_key_masked"`
	AuthTokenSet              bool   `json:"auth_token_set"`
	AuthTokenMask             string `json:"auth_token_masked"`
	Model                     string `json:"model"`
	OpusModel                 string `json:"opus_model"`
	SonnetModel               string `json:"sonnet_model"`
	HaikuModel                string `json:"haiku_model"`
	PermissionMode            string `json:"permission_mode"`
	AutoCompactWindow         string `json:"auto_compact_window"`
	DisableUnknownModelWindow bool   `json:"disable_unknown_model_window"`
	ModelsPath                string `json:"models_path"`
	ManualModels              string `json:"manual_models"`
	APIProtocol               string `json:"api_protocol"`
	KnownModels               string `json:"known_models"`
	// Path 是配置文件路径，方便用户在 NAS 上备份。
	Path string `json:"path"`
}

// Patch 是局部更新请求。指针字段为 nil 表示「不改」。
type Patch struct {
	BaseURL        *string `json:"base_url"`
	APIKey         *string `json:"api_key"`
	ClearAPIKey    *bool   `json:"clear_api_key"`
	AuthToken      *string `json:"auth_token"`
	ClearAuthToken *bool   `json:"clear_auth_token"`
	Model          *string `json:"model"`
	OpusModel      *string `json:"opus_model"`
	SonnetModel    *string `json:"sonnet_model"`
	HaikuModel     *string `json:"haiku_model"`
	PermissionMode *string `json:"permission_mode"`

	AutoCompactWindow         *string `json:"auto_compact_window"`
	DisableUnknownModelWindow *bool   `json:"disable_unknown_model_window"`
	ModelsPath                *string `json:"models_path"`
	ManualModels              *string `json:"manual_models"`
	APIProtocol               *string `json:"api_protocol"`
	KnownModels               *string `json:"known_models"`
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
	case errors.Is(err, os.ErrNotExist):
		// 首次启动，保持空配置
	default:
		return nil, fmt.Errorf("settings: 读取 %s: %w", path, err)
	}
	return s, nil
}

// Path 返回配置文件路径。
func (s *Store) Path() string { return s.path }

// Get 返回当前配置的副本。
func (s *Store) Get() Settings {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.cur
}

// Public 返回脱敏视图。
func (s *Store) Public() Public {
	cur := s.Get()
	p := Public{
		BaseURL:                   cur.BaseURL,
		APIKeySet:                 cur.APIKey != "",
		APIKeyMasked:              Mask(cur.APIKey),
		AuthTokenSet:              cur.AuthToken != "",
		AuthTokenMask:             Mask(cur.AuthToken),
		Model:                     cur.Model,
		OpusModel:                 cur.OpusModel,
		SonnetModel:               cur.SonnetModel,
		HaikuModel:                cur.HaikuModel,
		PermissionMode:            cur.PermissionMode,
		AutoCompactWindow:         cur.AutoCompactWindow,
		DisableUnknownModelWindow: cur.DisableUnknownModelWindow,
		ModelsPath:                cur.ModelsPath,
		ManualModels:              cur.ManualModels,
		APIProtocol:               cur.APIProtocol,
		KnownModels:               cur.KnownModels,
		Path:                      s.path,
	}
	return p
}

// Apply 合并补丁、写盘并更新内存态。
func (s *Store) Apply(p Patch) (Public, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	next := s.cur
	if p.BaseURL != nil {
		next.BaseURL = strings.TrimSpace(*p.BaseURL)
	}
	// 密钥字段的语义与其它字段不同：空串表示「用户没改」，不是「清空」。
	// 前端密码框回填的是脱敏占位，用户不动它就会提交空串；若把空串当清空，
	// 一次「只改模型」的保存就会静默抹掉密钥。清除必须显式传 ClearAPIKey。
	if p.APIKey != nil && strings.TrimSpace(*p.APIKey) != "" {
		next.APIKey = strings.TrimSpace(*p.APIKey)
	}
	if p.ClearAPIKey != nil && *p.ClearAPIKey {
		next.APIKey = ""
	}
	if p.AuthToken != nil && strings.TrimSpace(*p.AuthToken) != "" {
		next.AuthToken = strings.TrimSpace(*p.AuthToken)
	}
	if p.ClearAuthToken != nil && *p.ClearAuthToken {
		next.AuthToken = ""
	}
	if p.Model != nil {
		next.Model = strings.TrimSpace(*p.Model)
	}
	if p.OpusModel != nil {
		next.OpusModel = strings.TrimSpace(*p.OpusModel)
	}
	if p.SonnetModel != nil {
		next.SonnetModel = strings.TrimSpace(*p.SonnetModel)
	}
	if p.HaikuModel != nil {
		next.HaikuModel = strings.TrimSpace(*p.HaikuModel)
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
	if p.ModelsPath != nil {
		next.ModelsPath = strings.TrimSpace(*p.ModelsPath)
	}
	if p.ManualModels != nil {
		next.ManualModels = strings.TrimSpace(*p.ManualModels)
	}
	if p.APIProtocol != nil {
		next.APIProtocol = strings.TrimSpace(*p.APIProtocol)
	}
	if p.KnownModels != nil {
		next.KnownModels = strings.TrimSpace(*p.KnownModels)
	}

	if err := writeAtomic(s.path, next); err != nil {
		return Public{}, err
	}
	s.cur = next

	return Public{
		BaseURL:                   next.BaseURL,
		APIKeySet:                 next.APIKey != "",
		APIKeyMasked:              Mask(next.APIKey),
		AuthTokenSet:              next.AuthToken != "",
		AuthTokenMask:             Mask(next.AuthToken),
		Model:                     next.Model,
		OpusModel:                 next.OpusModel,
		SonnetModel:               next.SonnetModel,
		HaikuModel:                next.HaikuModel,
		PermissionMode:            next.PermissionMode,
		AutoCompactWindow:         next.AutoCompactWindow,
		DisableUnknownModelWindow: next.DisableUnknownModelWindow,
		ModelsPath:                next.ModelsPath,
		ManualModels:              next.ManualModels,
		APIProtocol:               next.APIProtocol,
		KnownModels:               next.KnownModels,
		Path:                      s.path,
	}, nil
}

// Env 把配置转成注入 claude 子进程的环境变量（只包含已设置的项）。
//
// 这些变量名是 Claude Code 官方支持的第三方接入方式；追加在继承环境之后，
// 因此会覆盖宿主机上已有的同名变量。
func (s *Store) Env() []string {
	return s.Get().Env()
}

// Env 返回该配置对应的环境变量列表。
func (v Settings) Env() []string {
	var out []string
	add := func(k, val string) {
		if val != "" {
			out = append(out, k+"="+val)
		}
	}
	add("ANTHROPIC_BASE_URL", v.BaseURL)
	add("ANTHROPIC_API_KEY", v.APIKey)
	add("ANTHROPIC_AUTH_TOKEN", v.AuthToken)
	add("ANTHROPIC_MODEL", v.Model)
	add("ANTHROPIC_DEFAULT_OPUS_MODEL", v.OpusModel)
	add("ANTHROPIC_DEFAULT_SONNET_MODEL", v.SonnetModel)
	add("ANTHROPIC_DEFAULT_HAIKU_MODEL", v.HaikuModel)
	add("CLAUDE_CODE_AUTO_COMPACT_WINDOW", v.AutoCompactWindow)
	if v.DisableUnknownModelWindow {
		out = append(out, "CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT=1")
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
