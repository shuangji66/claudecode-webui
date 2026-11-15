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
	// ClaudeBin 是 claude 可执行文件路径，空则由 Discover 自行查找（CCWEB_CLAUDE_BIN）。
	ClaudeBin string
	// AuthToken 非空时要求 Bearer token 鉴权（CCWEB_AUTH_TOKEN）。
	AuthToken string
	// ProjectsRoot 是「新建会话时可选工作目录」的根（CCWEB_PROJECTS_ROOT）。
	ProjectsRoot string
	// DataDir 存放运行期产生的临时数据（CCWEB_DATA_DIR）。
	DataDir string
	// Home 是派给 claude 子进程的 HOME（CCWEB_HOME）。
	Home string
	// MaxSessions 是最多同时常驻的 claude 子进程数（CCWEB_MAX_SESSIONS）。
	MaxSessions int
	// IdleTimeout 是会话空闲多久后被回收（CCWEB_IDLE_TIMEOUT）。
	IdleTimeout time.Duration
	// PermissionMode 是新建会话的默认权限模式（CCWEB_PERMISSION_MODE）。
	PermissionMode string
	// Model 是新建会话的默认模型（CCWEB_MODEL），空表示用 CLI 默认。
	Model string
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

// Load 解析环境变量并返回配置。version 由调用方注入。
func Load(version string) Config {
	home := os.Getenv("HOME")
	if home == "" {
		home = "/root"
	}
	dataDir := EnvOr("DATA_DIR", defaultDataDir())

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
		AdminSock:      EnvOr("ADMIN_SOCK", filepath.Join(dataDir, "ccweb.sock")),
		BaseURL:        baseURL,
		ClaudeBin:      EnvOr("CLAUDE_BIN", ""),
		AuthToken:      EnvOr("AUTH_TOKEN", ""),
		ProjectsRoot:   EnvOr("PROJECTS_ROOT", home),
		DataDir:        dataDir,
		Home:           EnvOr("HOME", home),
		MaxSessions:    maxSessions,
		IdleTimeout:    idle,
		PermissionMode: EnvOr("PERMISSION_MODE", ""),
		Model:          EnvOr("MODEL", ""),
		Version:        version,
	}
}
