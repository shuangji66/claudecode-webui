package config

import (
	"path/filepath"
	"strings"
	"testing"
)

func TestLoadDefaults(t *testing.T) {
	// 清掉所有可能干扰的环境变量
	for _, k := range []string{
		"ADMIN_SOCK", "BASEURL", "CLAUDE_BIN", "AUTH_TOKEN", "PROJECTS_ROOT",
		"DATA_DIR", "HOME", "MAX_SESSIONS", "IDLE_TIMEOUT", "PERMISSION_MODE", "MODEL",
		"WORKSPACES_FILE", "AUTO_START",
	} {
		t.Setenv(EnvPrefix+k, "")
	}
	t.Setenv("HOME", "/tmp/home")

	cfg := Load("v1")
	if cfg.Version != "v1" {
		t.Fatalf("Version = %q", cfg.Version)
	}
	if cfg.MaxSessions != 8 {
		t.Fatalf("MaxSessions = %d", cfg.MaxSessions)
	}
	if cfg.ProjectsRoot != "/tmp/home" {
		t.Fatalf("ProjectsRoot = %q", cfg.ProjectsRoot)
	}
	if cfg.BaseURL != "" {
		t.Fatalf("BaseURL = %q", cfg.BaseURL)
	}
	if !filepath.IsAbs(cfg.AdminSock) {
		t.Fatalf("AdminSock 应为绝对路径: %q", cfg.AdminSock)
	}
	assertUnderDataDir(t, cfg)
}

// 所有持久化文件必须落在数据目录下（用户明确要求统一管理）。
func assertUnderDataDir(t *testing.T, cfg Config) {
	t.Helper()
	for name, p := range map[string]string{
		"AdminSock":      cfg.AdminSock,
		"SettingsFile":   cfg.SettingsFile,
		"WorkspacesFile": cfg.WorkspacesFile,
		"ClaudeHome":     cfg.ClaudeHome,
	} {
		rel, err := filepath.Rel(cfg.DataDir, p)
		if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
			t.Fatalf("%s = %q 不在数据目录 %q 下", name, p, cfg.DataDir)
		}
	}
}

func TestLoadOverrides(t *testing.T) {
	t.Setenv(EnvPrefix+"ADMIN_SOCK", "/run/ccweb/app.sock")
	t.Setenv(EnvPrefix+"BASEURL", "app/ccweb/")
	t.Setenv(EnvPrefix+"AUTH_TOKEN", "tok")
	t.Setenv(EnvPrefix+"MAX_SESSIONS", "3")
	t.Setenv(EnvPrefix+"IDLE_TIMEOUT", "5m")
	t.Setenv(EnvPrefix+"CLAUDE_BIN", "/opt/claude")
	t.Setenv(EnvPrefix+"PERMISSION_MODE", "acceptEdits")
	t.Setenv(EnvPrefix+"MODEL", "sonnet")
	t.Setenv(EnvPrefix+"DATA_DIR", "/var/lib/ccweb")
	t.Setenv(EnvPrefix+"AUTO_START", "false")

	cfg := Load("v2")
	if cfg.AdminSock != "/run/ccweb/app.sock" {
		t.Fatalf("AdminSock = %q", cfg.AdminSock)
	}
	// baseurl 必须归一成「前导斜杠 + 无尾斜杠」，否则与 withBaseURL 的剥离逻辑对不上。
	if cfg.BaseURL != "/app/ccweb" {
		t.Fatalf("BaseURL = %q, want /app/ccweb", cfg.BaseURL)
	}
	if cfg.AuthToken != "tok" || cfg.MaxSessions != 3 {
		t.Fatalf("cfg = %+v", cfg)
	}
	if cfg.IdleTimeout.String() != "5m0s" {
		t.Fatalf("IdleTimeout = %s", cfg.IdleTimeout)
	}
	if cfg.ClaudeBin != "/opt/claude" || cfg.PermissionMode != "acceptEdits" || cfg.Model != "sonnet" {
		t.Fatalf("cfg = %+v", cfg)
	}
	// 未显式指定时，claude 的家目录与配置文件都跟着数据目录走
	if cfg.ClaudeHome != "/var/lib/ccweb/claude" {
		t.Fatalf("ClaudeHome = %q", cfg.ClaudeHome)
	}
	if cfg.SettingsFile != "/var/lib/ccweb/settings.json" {
		t.Fatalf("SettingsFile = %q", cfg.SettingsFile)
	}
	if cfg.WorkspacesFile != "/var/lib/ccweb/workspaces.json" {
		t.Fatalf("WorkspacesFile = %q", cfg.WorkspacesFile)
	}
	if cfg.AutoStart {
		t.Fatal("AUTO_START=false 应关闭自动启动")
	}
}

func TestLoadIgnoresBadNumbers(t *testing.T) {
	t.Setenv(EnvPrefix+"MAX_SESSIONS", "abc")
	t.Setenv(EnvPrefix+"IDLE_TIMEOUT", "not-a-duration")
	cfg := Load("v")
	if cfg.MaxSessions != 8 {
		t.Fatalf("非法数字应回退默认值，实际 %d", cfg.MaxSessions)
	}
	if cfg.IdleTimeout.Minutes() != 30 {
		t.Fatalf("非法时长应回退默认值，实际 %s", cfg.IdleTimeout)
	}
}
