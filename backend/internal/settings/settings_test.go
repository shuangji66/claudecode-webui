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

// OpenAI/Gemini 协议的 base 带 /v1，对话时必须剥掉，否则 CLI 拼成 /v1/v1/messages。
func TestChatBaseURLStripsV1ForOpenAI(t *testing.T) {
	cases := []struct {
		protocol, base, want string
	}{
		{ProtocolOpenAI, "http://127.0.0.1:7863/v1", "http://127.0.0.1:7863"},
		{ProtocolOpenAI, "http://127.0.0.1:7863/v1/", "http://127.0.0.1:7863"},
		{ProtocolResponses, "https://gw.example/openai/v1", "https://gw.example/openai"},
		{ProtocolGemini, "https://gw.example/v1beta", "https://gw.example/v1beta"},
		// Anthropic 协议保持原样：官方地址本身没有 /v1
		{ProtocolAnthropic, "https://api.anthropic.com", "https://api.anthropic.com"},
		{ProtocolAnthropic, "https://gw.example/v1", "https://gw.example/v1"},
	}
	for _, c := range cases {
		p := Provider{Protocol: c.protocol, BaseURL: c.base}
		if got := p.ChatBaseURL(); got != c.want {
			t.Fatalf("%s + %s → %q, want %q", c.protocol, c.base, got, c.want)
		}
	}
}

func TestEnvUsesChatBaseURL(t *testing.T) {
	v := Settings{
		Providers: []Provider{{
			ID: "gw", Protocol: ProtocolOpenAI, BaseURL: "http://127.0.0.1:7863/v1",
			APIKey: "sk-1", Models: []string{"cn:deepseek"},
		}},
		Selected: Selection{Provider: "gw", Model: "cn:deepseek"},
	}
	env := strings.Join(v.Env(), ",")
	if !strings.Contains(env, "ANTHROPIC_BASE_URL=http://127.0.0.1:7863,") &&
		!strings.HasSuffix(env, "ANTHROPIC_BASE_URL=http://127.0.0.1:7863") &&
		!strings.Contains(env, "ANTHROPIC_BASE_URL=http://127.0.0.1:7863") {
		t.Fatalf("对话地址应剥掉 /v1: %v", env)
	}
	if strings.Contains(env, "ANTHROPIC_BASE_URL=http://127.0.0.1:7863/v1") {
		t.Fatalf("不应保留 /v1: %v", env)
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

// 模型声明的容量要同时告诉 CLI：上下文窗口走 MAX_CONTEXT_TOKENS，
// 输出上限走 MAX_OUTPUT_TOKENS；全局压缩窗口是独立设置。
func TestEnvUsesModelCapacity(t *testing.T) {
	v := Settings{
		Providers: []Provider{{
			ID: "gw", Models: []string{"m1"},
			ModelMeta: map[string]ModelSpec{"m1": {ContextWindow: 1000000, MaxOutputTokens: 128000}},
		}},
		Selected: Selection{Provider: "gw", Model: "m1"},
	}
	env := strings.Join(v.Env(), ",")
	if !strings.Contains(env, "CLAUDE_CODE_MAX_CONTEXT_TOKENS=1000000") {
		t.Fatalf("缺少模型上下文窗口: %v", env)
	}
	if !strings.Contains(env, "CLAUDE_CODE_MAX_OUTPUT_TOKENS=128000") {
		t.Fatalf("缺少模型最大输出: %v", env)
	}

	v.AutoCompactWindow = "200k"
	env = strings.Join(v.Env(), ",")
	if !strings.Contains(env, "CLAUDE_CODE_AUTO_COMPACT_WINDOW=200k") {
		t.Fatalf("全局压缩窗口应独立注入: %v", env)
	}
	if !strings.Contains(env, "CLAUDE_CODE_MAX_CONTEXT_TOKENS=1000000") {
		t.Fatalf("上下文窗口不应被压缩窗口顶掉: %v", env)
	}

	// 没有选中模型时不应凭空注入容量。
	if got := strings.Join((Settings{}).Env(), ","); strings.Contains(got, "MAX_OUTPUT_TOKENS") || strings.Contains(got, "MAX_CONTEXT_TOKENS") || strings.Contains(got, "AUTO_COMPACT") {
		t.Fatalf("空配置不应注入容量: %v", got)
	}
}

func TestModelMetaAndEffort(t *testing.T) {
	s, _ := openTemp(t)
	if _, err := s.Apply(Patch{
		Providers: &[]ProviderPatch{{
			ID:     "gw",
			Models: []string{"m1", "m2"},
			ModelMeta: map[string]ModelSpec{
				"m1": {Name: "模型一", ReasoningEfforts: []string{"low", "high"}, DefaultReasoningEffort: "high", SupportsImage: true, ContextWindow: 1000000, MaxOutputTokens: 128000},
				"m2": {ReasoningEfforts: []string{"bogus"}},
			},
		}},
		Selected: &Selection{Provider: "gw", Model: "m1", Effort: "low"},
	}); err != nil {
		t.Fatalf("Apply: %v", err)
	}
	got := s.Get()
	p := got.Providers[0]
	spec := p.ModelMeta["m1"]
	if spec.Name != "模型一" || !spec.SupportsImage || spec.DefaultReasoningEffort != "high" {
		t.Fatalf("m1 meta = %+v", spec)
	}
	if spec.ContextWindow != 1000000 || spec.MaxOutputTokens != 128000 {
		t.Fatalf("容量字段应保留: %+v", spec)
	}
	if len(p.ModelMeta["m2"].ReasoningEfforts) != 0 {
		t.Fatalf("非法强度应被过滤: %+v", p.ModelMeta["m2"])
	}
	_, model, active, ok := got.ActiveModel()
	if !ok || model != "m1" || active.Name != "模型一" {
		t.Fatalf("ActiveModel = %q %+v ok=%v", model, active, ok)
	}
	if eff := got.DefaultEffort(); eff != "low" {
		t.Fatalf("DefaultEffort = %q", eff)
	}

	// 默认强度不合法时回落到列表第一项。
	if _, err := s.Apply(Patch{
		Providers: &[]ProviderPatch{{
			ID: "gw", Models: []string{"m1"},
			ModelMeta: map[string]ModelSpec{"m1": {ReasoningEfforts: []string{"medium", "high"}, DefaultReasoningEffort: "nope"}},
		}},
		Selected: &Selection{Provider: "gw", Model: "m1", Effort: "low"},
	}); err != nil {
		t.Fatalf("Apply: %v", err)
	}
	if eff := s.Get().DefaultEffort(); eff != "medium" {
		t.Fatalf("默认强度应回落到 medium，实际 %q", eff)
	}
}

func TestModelMetaPrunedWhenModelRemoved(t *testing.T) {
	s, _ := openTemp(t)
	if _, err := s.Apply(Patch{Providers: &[]ProviderPatch{{
		ID: "gw", Models: []string{"a", "b"},
		ModelMeta: map[string]ModelSpec{"a": {Name: "A"}, "b": {Name: "B"}},
	}}}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Apply(Patch{Providers: &[]ProviderPatch{{
		ID: "gw", Models: []string{"a"}, ModelMeta: map[string]ModelSpec{"a": {Name: "A"}, "b": {Name: "B"}},
	}}}); err != nil {
		t.Fatal(err)
	}
	p, _ := s.Get().Provider("gw")
	if _, ok := p.ModelMeta["b"]; ok {
		t.Fatalf("已移除模型的元数据不应保留: %+v", p.ModelMeta)
	}
}

func TestPreferencesPatchAndDefaults(t *testing.T) {
	s, path := openTemp(t)
	got := s.Get()
	if got.Theme != DefaultTheme || got.Locale != DefaultLocale || got.FontSize != DefaultFontSize {
		t.Fatalf("默认界面偏好 = %+v", got)
	}
	theme, locale, size := "dark", "en", 17
	if _, err := s.Apply(Patch{Theme: &theme, Locale: &locale, FontSize: &size}); err != nil {
		t.Fatalf("Apply: %v", err)
	}
	reopened, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	got = reopened.Get()
	if got.Theme != "dark" || got.Locale != "en" || got.FontSize != 17 {
		t.Fatalf("重开后偏好 = %+v", got)
	}

	badTheme := "neon"
	if _, err := s.Apply(Patch{Theme: &badTheme}); err == nil {
		t.Fatal("非法主题应报错")
	}
	badLocale := "fr"
	if _, err := s.Apply(Patch{Locale: &badLocale}); err == nil {
		t.Fatal("非法语言应报错")
	}
	badSize := 99
	if _, err := s.Apply(Patch{FontSize: &badSize}); err == nil {
		t.Fatal("非法字号应报错")
	}
}

func TestProxyURLPersistAndEnv(t *testing.T) {
	s, path := openTemp(t)
	if _, err := s.Apply(Patch{ProxyURL: strPtr("socks5://127.0.0.1:1080")}); err != nil {
		t.Fatalf("Apply: %v", err)
	}
	reopened, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	if got := reopened.Get().ProxyURL; got != "socks5://127.0.0.1:1080" {
		t.Fatalf("ProxyURL = %q", got)
	}
	env := strings.Join(reopened.Get().Env(), ",")
	for _, want := range []string{
		"HTTPS_PROXY=socks5://127.0.0.1:1080",
		"ALL_PROXY=socks5://127.0.0.1:1080",
		"NO_PROXY=localhost,127.0.0.1,::1",
	} {
		if !strings.Contains(env, want) {
			t.Fatalf("Env 缺少 %q: %v", want, env)
		}
	}
	if strings.Contains(env, "NODE_USE_ENV_PROXY") {
		t.Fatalf("socks5 不应设置 Node 内置代理开关: %v", env)
	}
	// 清空代理后不应再注入代理变量。
	if _, err := s.Apply(Patch{ProxyURL: strPtr("")}); err != nil {
		t.Fatal(err)
	}
	if env := strings.Join(s.Get().Env(), ","); strings.Contains(env, "PROXY=") {
		t.Fatalf("空代理仍注入变量: %v", env)
	}
}

func TestHTTPProxyEnablesNodeEnvProxy(t *testing.T) {
	v := Settings{ProxyURL: "http://127.0.0.1:7890"}
	env := strings.Join(v.Env(), ",")
	if !strings.Contains(env, "NODE_USE_ENV_PROXY=1") {
		t.Fatalf("HTTP 代理应启用 Node 内置代理: %v", env)
	}
}

func TestProxyURLValidation(t *testing.T) {
	if got, err := NormalizeProxyURL(""); err != nil || got != "" {
		t.Fatalf("空串 = %q, %v", got, err)
	}
	for _, ok := range []string{"http://127.0.0.1:7890", "https://proxy.example:443", "socks5://127.0.0.1:1080", "socks5h://proxy.example:1080"} {
		if _, err := NormalizeProxyURL(ok); err != nil {
			t.Fatalf("%q 应合法: %v", ok, err)
		}
	}
	for _, bad := range []string{"127.0.0.1:1080", "ftp://x:1", "socks5://", "http://"} {
		if _, err := NormalizeProxyURL(bad); err == nil {
			t.Fatalf("%q 应被拒绝", bad)
		}
	}
	s, _ := openTemp(t)
	if _, err := s.Apply(Patch{ProxyURL: strPtr("socks4://x:1")}); err == nil {
		t.Fatal("不支持的协议应报错")
	}
}
