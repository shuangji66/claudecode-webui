package gateway

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
)

// askQuestionTimeout 读 claude 用户级 settings 的 askUserQuestionTimeout。
//
// 取值 `never` / `60s` / `5m` / `10m`，默认 `never`（v2.1.200 起；2.1.198/199 曾短暂把
// 60s 当默认）。它**只认用户级** settings，写进项目级无效，所以这里只读
// `$CCWEB_CLAUDE_HOME/.claude/settings.json`。
//
// 前端拿它只为提示「不回答的话 CLI 到点会自己收尾」——ccweb 不替用户改这项设置。
// 读不到、类型不对、文件坏了都返回空串（界面据此不提示）：这是提示信息，
// 不能因为 claude 自己的状态文件而让 /api/info 失败。
func askQuestionTimeout(claudeHome string) string {
	if claudeHome == "" {
		return ""
	}
	b, err := os.ReadFile(filepath.Join(claudeHome, ".claude", "settings.json"))
	if err != nil {
		return ""
	}
	var top map[string]json.RawMessage
	if err := json.Unmarshal(b, &top); err != nil {
		return ""
	}
	raw, ok := top["askUserQuestionTimeout"]
	if !ok {
		return ""
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return ""
	}
	return strings.TrimSpace(value)
}
