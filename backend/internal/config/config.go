// Package config 负责把运行期配置从环境变量解析出来。
//
// 约定：本应用只通过 unix socket + baseurl 前缀对外提供服务，两者都从环境变量获取，
// 由前置网关（nginx / 飞牛网关等）反代到该 socket。程序自身不监听 TCP。
package config

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// EnvPrefix 是所有环境变量的统一前缀。
const EnvPrefix = "CCWEB_"

// Config 是进程启动所需的全部配置。
type Config struct {
	// AdminSock 是唯一访问入口的 unix socket 路径（CCWEB_ADMIN_SOCK）。
	AdminSock string
	// BaseURL 是网关暴露给前端的路径前缀，空表示挂在根路径（CCWEB_BASEURL）。
	BaseURL string
	// AuthToken 非空时要求 Bearer token 鉴权（CCWEB_AUTH_TOKEN）。
	AuthToken string
	// ProjectsRoot 是「新建会话时可选工作目录」的根（CCWEB_PROJECTS_ROOT）。
	ProjectsRoot string
	// DataDir 存放运行期产生的临时数据（CCWEB_DATA_DIR）。
	DataDir string
	// ClaudeVersions 是托管 claude 的版本目录（CCWEB_CLAUDE_VERSIONS）。
	// 每个版本一个子目录；磁盘紧张时可以直接删掉旧版本目录。
	ClaudeVersions string
	// ClaudeHome 是派给 claude 子进程的 HOME（CCWEB_CLAUDE_HOME）。
	// 默认落在数据目录下，使 claude 的会话转录、登录态与其它持久化文件集中可备份。
	ClaudeHome string
	// SettingsFile 是持久化配置（含第三方端点与密钥）的路径（CCWEB_SETTINGS_FILE）。
	SettingsFile string
	// WorkspacesFile 是授权目录 / 当前工作区的持久化路径（CCWEB_WORKSPACES_FILE）。
	WorkspacesFile string
	// ConversationsFile 是对话元数据（归档/删除/重命名/最近活跃）的持久化路径
	// （CCWEB_CONVERSATIONS_FILE）。
	ConversationsFile string
	// AutoStart 为 true 时，进程启动后恢复当前工作区最近的一条对话（CCWEB_AUTO_START）；
	// 没有历史对话时不新建，由前端创建第一条。
	AutoStart bool
	// MaxSessions 是最多同时常驻的 claude 子进程数（CCWEB_MAX_SESSIONS）。
	MaxSessions int
	// IdleTimeout 是会话空闲多久后被回收（CCWEB_IDLE_TIMEOUT）。
	IdleTimeout time.Duration
	// PermissionMode 是新建会话的默认权限模式（CCWEB_PERMISSION_MODE）。
	PermissionMode string
	// Model 是新建会话的默认模型（CCWEB_MODEL），空表示用 CLI 默认。
	Model string
	// TerminalShell 是右侧栏内置终端使用的 shell（CCWEB_TERMINAL_SHELL）。
	// 空表示依次尝试 $SHELL / bash / sh。
	TerminalShell string
	// Version 由 -ldflags 注入。
	Version string
}

// EnvOr 返回环境变量值，为空时返回默认值。
func EnvOr(key, def string) string {
	if v := os.Getenv(EnvPrefix + key); v != "" {
		return v
	}
	return def
}

// defaultDataDir 返回默认的可写数据目录。
func defaultDataDir() string {
	return filepath.Join(os.TempDir(), "ccweb")
}

// envBool 解析布尔型环境变量；空值取默认，无法识别时也取默认。
func envBool(key string, def bool) bool {
	v := strings.ToLower(strings.TrimSpace(EnvOr(key, "")))
	switch v {
	case "":
		return def
	case "1", "true", "yes", "on":
		return true
	case "0", "false", "no", "off":
		return false
	default:
		return def
	}
}

// Load 解析环境变量并返回配置。version 由调用方注入。
func Load(version string) Config {
	home := os.Getenv("HOME")
	if home == "" {
		home = "/root"
	}
	dataDir := EnvOr("DATA_DIR", defaultDataDir())
	// 兼容旧变量 CCWEB_HOME：显式给了就优先，否则统一落到数据目录下的 claude/。
	claudeHome := EnvOr("CLAUDE_HOME", EnvOr("HOME", filepath.Join(dataDir, "claude")))

	maxSessions := 8
	if v := EnvOr("MAX_SESSIONS", ""); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			maxSessions = n
		}
	}

	idle := 30 * time.Minute
	if v := EnvOr("IDLE_TIMEOUT", ""); v != "" {
		if d, err := time.ParseDuration(v); err == nil && d > 0 {
			idle = d
		}
	}

	baseURL := EnvOr("BASEURL", "")
	if baseURL != "" && !strings.HasPrefix(baseURL, "/") {
		baseURL = "/" + baseURL
	}
	baseURL = strings.TrimRight(baseURL, "/")

	return Config{
		AdminSock:         EnvOr("ADMIN_SOCK", filepath.Join(dataDir, "ccweb.sock")),
		BaseURL:           baseURL,
		AuthToken:         EnvOr("AUTH_TOKEN", ""),
		ProjectsRoot:      EnvOr("PROJECTS_ROOT", home),
		DataDir:           dataDir,
		ClaudeHome:        claudeHome,
		ClaudeVersions:    EnvOr("CLAUDE_VERSIONS", filepath.Join(dataDir, "claude", "versions")),
		SettingsFile:      EnvOr("SETTINGS_FILE", filepath.Join(dataDir, "settings.json")),
		WorkspacesFile:    EnvOr("WORKSPACES_FILE", filepath.Join(dataDir, "workspaces.json")),
		ConversationsFile: EnvOr("CONVERSATIONS_FILE", filepath.Join(dataDir, "conversations.json")),
		AutoStart:         envBool("AUTO_START", true),
		MaxSessions:       maxSessions,
		IdleTimeout:       idle,
		PermissionMode:    EnvOr("PERMISSION_MODE", ""),
		Model:             EnvOr("MODEL", ""),
		TerminalShell:     EnvOr("TERMINAL_SHELL", ""),
		Version:           version,
	}
}
