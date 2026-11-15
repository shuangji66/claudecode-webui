package settings

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func openTemp(t *testing.T) (*Store, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "settings.json")
	s, err := Open(path)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	return s, path
}

func TestOpenMissingFileYieldsEmpty(t *testing.T) {
	s, _ := openTemp(t)
	if got := s.Get(); got != (Settings{}) {
		t.Fatalf("缺失文件应为空配置，实际 %+v", got)
	}
}

func TestSaveAndReload(t *testing.T) {
	s, path := openTemp(t)
	if _, err := s.Apply(Patch{
		BaseURL: strPtr("https://relay.example.com"),
		APIKey:  strPtr("sk-ant-secret-123456"),
		Model:   strPtr("claude-opus-5-5"),
	}); err != nil {
		t.Fatalf("Apply: %v", err)
	}

	reopened, err := Open(path)
	if err != nil {
		t.Fatalf("重新打开: %v", err)
	}
	got := reopened.Get()
	if got.BaseURL != "https://relay.example.com" {
		t.Fatalf("BaseURL = %q", got.BaseURL)
	}
	if got.APIKey != "sk-ant-secret-123456" {
		t.Fatalf("APIKey 未持久化")
	}
	if got.Model != "claude-opus-5-5" {
		t.Fatalf("Model = %q", got.Model)
	}
}

// 文件里有密钥，权限必须是 0600。
func TestFilePermissions(t *testing.T) {
	s, path := openTemp(t)
	if _, err := s.Apply(Patch{APIKey: strPtr("sk-x")}); err != nil {
		t.Fatalf("Apply: %v", err)
	}
	st, err := os.Stat(path)
	if err != nil {
		t.Fatalf("Stat: %v", err)
	}
	if perm := st.Mode().Perm(); perm != 0o600 {
		t.Fatalf("权限 = %o, want 600", perm)
	}
}

func TestPublicMasksSecrets(t *testing.T) {
	s, _ := openTemp(t)
	if _, err := s.Apply(Patch{
		APIKey:    strPtr("sk-ant-api03-abcdefghijklmn"),
		AuthToken: strPtr("tok"),
	}); err != nil {
		t.Fatalf("Apply: %v", err)
	}
	pub := s.Public()
	if !pub.APIKeySet || !pub.AuthTokenSet {
		t.Fatal("应标记为已设置")
	}
	if strings.Contains(pub.APIKeyMasked, "abcdefghij") {
		t.Fatalf("脱敏后不应包含明文片段: %q", pub.APIKeyMasked)
	}
	if strings.Contains(pub.AuthTokenMask, "tok") && pub.AuthTokenMask != "•••" {
		t.Fatalf("短密钥应全部打点: %q", pub.AuthTokenMask)
	}
	// 整个 Public 序列化后也不能夹带明文
	b, _ := json.Marshal(pub)
	if strings.Contains(string(b), "abcdefghijklmn") {
		t.Fatalf("Public 序列化泄露明文: %s", b)
	}
}

func TestPatchNilMeansUnchanged(t *testing.T) {
	s, _ := openTemp(t)
	if _, err := s.Apply(Patch{BaseURL: strPtr("https://a"), APIKey: strPtr("k1")}); err != nil {
		t.Fatalf("Apply: %v", err)
	}
	// 只改 BaseURL，APIKey 必须保留
	if _, err := s.Apply(Patch{BaseURL: strPtr("https://b")}); err != nil {
		t.Fatalf("Apply: %v", err)
	}
	got := s.Get()
	if got.BaseURL != "https://b" {
		t.Fatalf("BaseURL = %q", got.BaseURL)
	}
	if got.APIKey != "k1" {
		t.Fatalf("未传的字段被清空了: %q", got.APIKey)
	}
}

// 空字符串与「显式清除」语义不同：前者是用户清空了输入框，后者是按钮动作。
// 前端密码框留空会传 ""，绝不能因此把已保存的密钥抹掉。
func TestEmptySecretKeepsExisting(t *testing.T) {
	s, _ := openTemp(t)
	if _, err := s.Apply(Patch{APIKey: strPtr("k1"), AuthToken: strPtr("t1")}); err != nil {
		t.Fatalf("Apply: %v", err)
	}
	if _, err := s.Apply(Patch{APIKey: strPtr(""), AuthToken: strPtr(""), Model: strPtr("m2")}); err != nil {
		t.Fatalf("Apply: %v", err)
	}
	got := s.Get()
	if got.APIKey != "k1" || got.AuthToken != "t1" {
		t.Fatalf("空串不应清空密钥: %+v", got)
	}
	if got.Model != "m2" {
		t.Fatalf("其它字段应正常更新: %+v", got)
	}
}

func TestExplicitClear(t *testing.T) {
	s, _ := openTemp(t)
	if _, err := s.Apply(Patch{APIKey: strPtr("k1"), AuthToken: strPtr("t1")}); err != nil {
		t.Fatalf("Apply: %v", err)
	}
	if _, err := s.Apply(Patch{ClearAPIKey: boolPtr(true), ClearAuthToken: boolPtr(true)}); err != nil {
		t.Fatalf("Apply: %v", err)
	}
	got := s.Get()
	if got.APIKey != "" || got.AuthToken != "" {
		t.Fatalf("清除失败: %+v", got)
	}
}

func TestEnvMapping(t *testing.T) {
	v := Settings{
		BaseURL:     "https://relay.local",
		APIKey:      "sk-1",
		AuthToken:   "tok",
		Model:       "m-default",
		OpusModel:   "m-opus",
		SonnetModel: "m-sonnet",
		HaikuModel:  "m-haiku",
	}
	env := v.Env()
	want := map[string]string{
		"ANTHROPIC_BASE_URL":             "https://relay.local",
		"ANTHROPIC_API_KEY":              "sk-1",
		"ANTHROPIC_AUTH_TOKEN":           "tok",
		"ANTHROPIC_MODEL":                "m-default",
		"ANTHROPIC_DEFAULT_OPUS_MODEL":   "m-opus",
		"ANTHROPIC_DEFAULT_SONNET_MODEL": "m-sonnet",
		"ANTHROPIC_DEFAULT_HAIKU_MODEL":  "m-haiku",
	}
	got := map[string]string{}
	for _, kv := range env {
		k, val, _ := strings.Cut(kv, "=")
		got[k] = val
	}
	for k, w := range want {
		if got[k] != w {
			t.Fatalf("%s = %q, want %q", k, got[k], w)
		}
	}
}

func TestEnvAdvancedWindows(t *testing.T) {
	v := Settings{AutoCompactWindow: "200k", DisableUnknownModelWindow: true}
	env := v.Env()
	joined := strings.Join(env, ",")
	if !strings.Contains(joined, "CLAUDE_CODE_AUTO_COMPACT_WINDOW=200k") {
		t.Fatalf("缺少窗口设置: %v", env)
	}
	if !strings.Contains(joined, "CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT=1") {
		t.Fatalf("缺少未知模型窗口开关: %v", env)
	}

	// 关闭时不应注入该变量
	if strings.Contains(strings.Join(Settings{}.Env(), ","), "DISABLE_UNKNOWN") {
		t.Fatal("未开启时不应注入")
	}
}

func TestEnvSkipsEmpty(t *testing.T) {
	env := Settings{BaseURL: "https://x"}.Env()
	if len(env) != 1 {
		t.Fatalf("只应有 BaseURL 一项，实际 %v", env)
	}
}

func TestMask(t *testing.T) {
	cases := []struct{ in, want string }{
		{"", ""},
		{"abc", "•••"},
		{"abcdefghij", "ab••••••ij"},
		{"sk-ant-api03-verylongsecretvalue", "sk-ant••••••alue"},
	}
	for _, c := range cases {
		if got := Mask(c.in); got != c.want {
			t.Fatalf("Mask(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestProbeRejectsBadScheme(t *testing.T) {
	res := Probe(t.Context(), Settings{BaseURL: "relay.example.com"})
	if res.OK {
		t.Fatal("缺少 scheme 应失败")
	}
	if !strings.Contains(res.Detail, "http") {
		t.Fatalf("提示不清楚: %q", res.Detail)
	}
}

func strPtr(s string) *string { return &s }
func boolPtr(b bool) *bool    { return &b }
