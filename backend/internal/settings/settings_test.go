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

func strPtr(s string) *string { return &s }
func boolPtr(b bool) *bool    { return &b }

func TestOpenMissingFileYieldsEmpty(t *testing.T) {
	s, _ := openTemp(t)
	got := s.Get()
	if len(got.Providers) != 0 || got.Selected.Model != "" {
		t.Fatalf("缺失文件应为空配置，实际 %+v", got)
	}
}

func TestSaveProvidersAndReload(t *testing.T) {
	s, path := openTemp(t)
	if _, err := s.Apply(Patch{
		Providers: &[]ProviderPatch{{
			ID:       "gw",
			Name:     "我的网关",
			Protocol: ProtocolAnthropic,
			BaseURL:  "https://gw.example/",
			APIKey:   "sk-ant-secret-123456",
			Models:   []string{"cn:deepseek", "cn:qwen", "cn:deepseek"},
		}},
		Selected: &Selection{Provider: "gw", Model: "cn:deepseek"},
	}); err != nil {
		t.Fatalf("Apply: %v", err)
	}

	reopened, err := Open(path)
	if err != nil {
		t.Fatalf("重新打开: %v", err)
	}
	got := reopened.Get()
	if len(got.Providers) != 1 {
		t.Fatalf("providers = %+v", got.Providers)
	}
	p := got.Providers[0]
	if p.BaseURL != "https://gw.example" {
		t.Fatalf("BaseURL 应去掉尾斜杠: %q", p.BaseURL)
	}
	if p.APIKey != "sk-ant-secret-123456" {
		t.Fatal("密钥未持久化")
	}
	if len(p.Models) != 2 {
		t.Fatalf("模型应去重: %v", p.Models)
	}
	if got.Selected.Model != "cn:deepseek" {
		t.Fatalf("Selected = %+v", got.Selected)
	}
}

func TestFilePermissions(t *testing.T) {
	s, path := openTemp(t)
	if _, err := s.Apply(Patch{Providers: &[]ProviderPatch{{ID: "a", APIKey: "sk-x"}}}); err != nil {
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

func TestPublicMasksKeys(t *testing.T) {
	s, _ := openTemp(t)
	if _, err := s.Apply(Patch{Providers: &[]ProviderPatch{{
		ID: "gw", APIKey: "sk-ant-api03-abcdefghijklmn", AuthToken: "tok",
	}}}); err != nil {
		t.Fatalf("Apply: %v", err)
	}
	pub := s.Public()
	if len(pub.Providers) != 1 {
		t.Fatalf("providers = %+v", pub.Providers)
	}
	p := pub.Providers[0]
	if !p.APIKeySet || !p.AuthTokenSet {
		t.Fatal("应标记为已设置")
	}
	if strings.Contains(p.APIKeyMasked, "abcdefghij") {
		t.Fatalf("脱敏后不应包含明文: %q", p.APIKeyMasked)
	}
	b, _ := json.Marshal(pub)
	if strings.Contains(string(b), "abcdefghijklmn") || strings.Contains(string(b), `"tok"`) {
		t.Fatalf("Public 序列化泄露明文: %s", b)
	}
}

// 前端密码框留空会传 ""，绝不能因此把已保存的密钥抹掉。
func TestEmptyKeyKeepsExisting(t *testing.T) {
	s, _ := openTemp(t)
	if _, err := s.Apply(Patch{Providers: &[]ProviderPatch{{ID: "gw", APIKey: "k1"}}}); err != nil {
		t.Fatalf("Apply: %v", err)
	}
	// 只改模型列表，密钥留空
	if _, err := s.Apply(Patch{Providers: &[]ProviderPatch{{
		ID: "gw", APIKey: "", Models: []string{"m1"},
	}}}); err != nil {
		t.Fatalf("Apply: %v", err)
	}
	p, _ := s.Get().Provider("gw")
	if p.APIKey != "k1" {
		t.Fatalf("空串不应清空密钥: %q", p.APIKey)
	}
	if len(p.Models) != 1 || p.Models[0] != "m1" {
		t.Fatalf("模型未更新: %v", p.Models)
	}
}

func TestClearKeyExplicit(t *testing.T) {
	s, _ := openTemp(t)
	if _, err := s.Apply(Patch{Providers: &[]ProviderPatch{{ID: "gw", APIKey: "k1", AuthToken: "t1"}}}); err != nil {
		t.Fatalf("Apply: %v", err)
	}
	if _, err := s.Apply(Patch{Providers: &[]ProviderPatch{{ID: "gw", ClearKey: true}}}); err != nil {
		t.Fatalf("Apply: %v", err)
	}
	p, _ := s.Get().Provider("gw")
	if p.APIKey != "" || p.AuthToken != "" {
		t.Fatalf("清除失败: %+v", p)
	}
}

func TestProviderIDValidation(t *testing.T) {
	s, _ := openTemp(t)
	if _, err := s.Apply(Patch{Providers: &[]ProviderPatch{{ID: ""}}}); err == nil {
		t.Fatal("空 ID 应报错")
	}
	if _, err := s.Apply(Patch{Providers: &[]ProviderPatch{{ID: "a"}, {ID: "a"}}}); err == nil {
		t.Fatal("重复 ID 应报错")
	}
}

// 删除 provider 后不能留下悬空的选中项。
func TestSelectionClearedWhenProviderRemoved(t *testing.T) {
	s, _ := openTemp(t)
	if _, err := s.Apply(Patch{
		Providers: &[]ProviderPatch{{ID: "gw", Models: []string{"m"}}},
		Selected:  &Selection{Provider: "gw", Model: "m"},
	}); err != nil {
		t.Fatalf("Apply: %v", err)
	}
	if _, err := s.Apply(Patch{Providers: &[]ProviderPatch{}}); err != nil {
		t.Fatalf("Apply: %v", err)
	}
	if got := s.Get().Selected; got.Provider != "" || got.Model != "" {
		t.Fatalf("选中项应被清空: %+v", got)
	}
}

// 旧版「单端点 + 别名槽位」配置应自动迁移成一个 provider。
func TestLegacyMigration(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "settings.json")
	legacy := `{
	  "base_url": "http://127.0.0.1:7863",
	  "api_key": "sk-old",
	  "api_protocol": "openai-completions",
	  "model": "cn:deepseek-v4.1-flash",
	  "opus_model": "cn:deepseek-v4.1-flash",
	  "sonnet_model": "cn:qwen-max",
	  "haiku_model": "cn:qwen-max"
	}`
	if err := os.WriteFile(path, []byte(legacy), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	s, err := Open(path)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	got := s.Get()
	if len(got.Providers) != 1 {
		t.Fatalf("应迁移出 1 个 provider: %+v", got.Providers)
	}
	p := got.Providers[0]
	if p.BaseURL != "http://127.0.0.1:7863" || p.APIKey != "sk-old" {
		t.Fatalf("迁移字段不对: %+v", p)
	}
	if p.Protocol != ProtocolOpenAI {
		t.Fatalf("协议未迁移: %q", p.Protocol)
	}
	// 四个别名槽位去重成两个模型
	if len(p.Models) != 2 {
		t.Fatalf("模型应去重为 2 个: %v", p.Models)
	}
	if got.Selected.Model != "cn:deepseek-v4.1-flash" {
		t.Fatalf("选中项未迁移: %+v", got.Selected)
	}
	// 迁移后旧字段应清空，保存时才不会重复迁移
	if got.LegacyBaseURL != "" || got.LegacyAPIKey != "" {
		t.Fatalf("旧字段应被清空: %+v", got)
	}
	_ = path
}

func TestActiveFallsBackToSelectedEvenIfRemovedFromList(t *testing.T) {
	// 模型从列表移除，但选择仍指向它：不能让会话凭空失效
	v := Settings{
		Providers: []Provider{{ID: "gw", Models: []string{"other"}}},
		Selected:  Selection{Provider: "gw", Model: "gone"},
	}
	if _, m, ok := v.Active(); !ok || m != "gone" {
		t.Fatalf("应仍视为有效: ok=%v m=%q", ok, m)
	}
}

func TestEnvUsesBearerWhenNoAPIKey(t *testing.T) {
	v := Settings{
		Providers: []Provider{{ID: "g", BaseURL: "https://x", AuthToken: "t1", Models: []string{"m"}}},
		Selected:  Selection{Provider: "g", Model: "m"},
	}
	env := strings.Join(v.Env(), ",")
	if !strings.Contains(env, "ANTHROPIC_AUTH_TOKEN=t1") {
		t.Fatalf("应使用 Bearer: %v", env)
	}
	if strings.Contains(env, "ANTHROPIC_API_KEY") {
		t.Fatalf("不应同时设置 API_KEY: %v", env)
	}
}

// 提供商没有模型时，JSON 必须是 []，不能是 null —— 否则前端 map 会抛错白屏。
func TestPublicEmptyModelsIsArrayNotNull(t *testing.T) {
	s, _ := openTemp(t)
	if _, err := s.Apply(Patch{Providers: &[]ProviderPatch{{ID: "empty"}}}); err != nil {
		t.Fatalf("Apply: %v", err)
	}
	b, err := json.Marshal(s.Public())
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	if strings.Contains(string(b), `"models":null`) {
		t.Fatalf("models 不应为 null: %s", b)
	}
	if !strings.Contains(string(b), `"models":[]`) {
		t.Fatalf("models 应为空数组: %s", b)
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

func TestAutoCompactEnv(t *testing.T) {
	v := Settings{AutoCompactWindow: "200k", DisableUnknownModelWindow: true}
	env := strings.Join(v.Env(), ",")
	if !strings.Contains(env, "CLAUDE_CODE_AUTO_COMPACT_WINDOW=200k") {
		t.Fatalf("缺少窗口设置: %v", env)
	}
	if !strings.Contains(env, "CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT=1") {
		t.Fatalf("缺少未知模型窗口开关: %v", env)
	}
	if strings.Contains(strings.Join(Settings{}.Env(), ","), "DISABLE_UNKNOWN") {
		t.Fatal("未开启时不应注入")
	}
}
