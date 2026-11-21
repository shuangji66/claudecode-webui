// Package config 负责把运行期配置从环境变量解析出来。
//
// 约定：本应用有两条入口——unix socket（前置网关按 baseurl 前缀反代）与
// 直连 TCP 端口（端口在设置页里配置，默认 3141，挂在根路径）。
// socket 路径、baseurl 与 TCP 绑定地址都来自环境变量（见下方 Config）。
package config

import (
	"os"
	"path/filepath"
	"strings"
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
	// TCPHost 是直连 TCP 端口绑定的地址（CCWEB_TCP_HOST），空表示所有网卡。
	// 端口本身来自设置页（默认 3141），因为要在界面上可改、改完立即换监听。
	TCPHost string
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
	// SchedulesFile 是自动化任务的持久化路径（CCWEB_SCHEDULES_FILE）。
	// MCP 子命令 `ccweb mcp-schedule` 读的是同一份文件。
	SchedulesFile string
	// BrowserDir 是内置浏览器运行时（固定版本 playwright 包 + 内核）的根目录
	// （CCWEB_BROWSER_DIR）。MCP 子命令 `ccweb mcp-browser` 读同一份路径。
	BrowserDir string
	// AutoStart 为 true 时，进程启动后恢复当前工作区最近的一条对话（CCWEB_AUTO_START）；
	// 没有历史对话时不新建，由前端创建第一条。
	AutoStart bool
	// PermissionMode 是新建会话的默认权限模式（CCWEB_PERMISSION_MODE）。
	PermissionMode string
	// Model 是新建会话的默认模型（CCWEB_MODEL），空表示用 CLI 默认。
	Model string
	// TerminalShell 是右侧栏内置终端使用的 shell（CCWEB_TERMINAL_SHELL）。
	// 空表示依次尝试 $SHELL / bash / sh。
	TerminalShell string
	// TrimSocket 是飞牛应用网关（apiscope）的 unix socket（CCWEB_TRIM_SOCKET）。
	// 默认是平台固定路径；改它只用于测试与联调。
	TrimSocket string
	// TrimAppName 是本应用在飞牛里的 appname（TRIM_APPNAME，飞牛启动 cmd/main 时注入）。
	TrimAppName string
	// TrimToken 现读飞牛注入的 API token（TRIM_API_TOKEN）。
	//
	// 用函数而不是字符串：飞牛会在应用重新注册/重装后换掉 token，缓存一份就会 401，
	// 官方文档也明确要求「每次调用现读、不落盘、不下发前端」。
	TrimToken func() string
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

// trimEnvOr 读飞牛平台注入的环境变量（它们不带 CCWEB_ 前缀）。
func trimEnvOr(key, def string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
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

	baseURL := EnvOr("BASEURL", "")
	if baseURL != "" && !strings.HasPrefix(baseURL, "/") {
		baseURL = "/" + baseURL
	}
	baseURL = strings.TrimRight(baseURL, "/")

	return Config{
		AdminSock:         EnvOr("ADMIN_SOCK", filepath.Join(dataDir, "ccweb.sock")),
		BaseURL:           baseURL,
		AuthToken:         EnvOr("AUTH_TOKEN", ""),
		TCPHost:           EnvOr("TCP_HOST", ""),
		ProjectsRoot:      EnvOr("PROJECTS_ROOT", home),
		DataDir:           dataDir,
		ClaudeHome:        claudeHome,
		ClaudeVersions:    EnvOr("CLAUDE_VERSIONS", filepath.Join(dataDir, "claude", "versions")),
		SettingsFile:      EnvOr("SETTINGS_FILE", filepath.Join(dataDir, "settings.json")),
		WorkspacesFile:    EnvOr("WORKSPACES_FILE", filepath.Join(dataDir, "workspaces.json")),
		ConversationsFile: EnvOr("CONVERSATIONS_FILE", filepath.Join(dataDir, "conversations.json")),
		SchedulesFile:     EnvOr("SCHEDULES_FILE", filepath.Join(dataDir, "schedules.json")),
		BrowserDir:        EnvOr("BROWSER_DIR", filepath.Join(dataDir, "browser")),
		AutoStart:         envBool("AUTO_START", true),
		PermissionMode:    EnvOr("PERMISSION_MODE", ""),
		Model:             EnvOr("MODEL", ""),
		TerminalShell:     EnvOr("TERMINAL_SHELL", ""),
		TrimSocket:        trimEnvOr("CCWEB_TRIM_SOCKET", "/var/run/trim_open_gateway_apiscope.socket"),
		TrimAppName:       trimEnvOr("TRIM_APPNAME", "ClaudeCode"),
		TrimToken:         func() string { return os.Getenv("TRIM_API_TOKEN") },
		Version:           version,
	}
}
