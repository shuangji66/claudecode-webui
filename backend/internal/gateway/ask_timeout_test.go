package gateway

import (
	"os"
	"path/filepath"
	"testing"
)

// askQuestionTimeout 读的是 claude 用户级 settings；读不出来一律空串（界面不提示）。
func TestAskQuestionTimeout(t *testing.T) {
	cases := []struct {
		name    string
		content string // 空串表示不写文件
		want    string
	}{
		{name: "没有配置文件", content: "", want: ""},
		{name: "配置了 5m", content: `{"askUserQuestionTimeout":"5m"}`, want: "5m"},
		{name: "never 原样返回", content: `{"askUserQuestionTimeout":"never"}`, want: "never"},
		{name: "其他键不影响", content: `{"model":"opus","askUserQuestionTimeout":"10m"}`, want: "10m"},
		{name: "值类型不对", content: `{"askUserQuestionTimeout":300}`, want: ""},
		{name: "坏 JSON", content: `{`, want: ""},
		{name: "缺少这个键", content: `{"model":"opus"}`, want: ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			home := t.TempDir()
			if tc.content != "" {
				dir := filepath.Join(home, ".claude")
				if err := os.MkdirAll(dir, 0o755); err != nil {
					t.Fatalf("建目录: %v", err)
				}
				if err := os.WriteFile(filepath.Join(dir, "settings.json"), []byte(tc.content), 0o600); err != nil {
					t.Fatalf("写文件: %v", err)
				}
			}
			if got := askQuestionTimeout(home); got != tc.want {
				t.Fatalf("askQuestionTimeout(%q) = %q, 期望 %q", tc.content, got, tc.want)
			}
		})
	}

	if got := askQuestionTimeout(""); got != "" {
		t.Fatalf("空 home 应返回空串，实际 %q", got)
	}
}
