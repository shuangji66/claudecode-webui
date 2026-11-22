package settings

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"ccweb/backend/internal/authz"
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
			ID:      "gw",
			Name:    "我的网关",
			BaseURL: "https://gw.example/",
			APIKey:  "sk-ant-secret-123456",
			Models:  []string{"cn:deepseek", "cn:qwen", "cn:deepseek"},
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
		ID: "gw", APIKey: "sk-ant-api03-abcdefghijklmn", Auth: AuthBearer,
	}}}); err != nil {
		t.Fatalf("Apply: %v", err)
	}
	pub := s.Public()
	if len(pub.Providers) != 1 {
		t.Fatalf("providers = %+v", pub.Providers)
	}
	p := pub.Providers[0]
	if !p.APIKeySet {
		t.Fatal("应标记为已设置")
	}
	if p.Auth != AuthBearer {
		t.Fatalf("认证方式应回传，实际 %q", p.Auth)
	}
	if strings.Contains(p.APIKeyMasked, "abcdefghij") {
		t.Fatalf("脱敏后不应包含明文: %q", p.APIKeyMasked)
	}
	b, _ := json.Marshal(pub)
	if strings.Contains(string(b), "abcdefghijklmn") {
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
	if _, err := s.Apply(Patch{Providers: &[]ProviderPatch{{ID: "gw", APIKey: "k1"}}}); err != nil {
		t.Fatalf("Apply: %v", err)
	}
	if _, err := s.Apply(Patch{Providers: &[]ProviderPatch{{ID: "gw", ClearKey: true}}}); err != nil {
		t.Fatalf("Apply: %v", err)
	}
	p, _ := s.Get().Provider("gw")
	if p.APIKey != "" {
		t.Fatalf("清除失败: %+v", p)
	}
}

// 读盘路径同样要迁移：旧 settings.json 里 provider 的 auth_token 是独立字段，
// 不合并的话升级后那把密钥就从配置里消失了（对话直接 401）。
func TestOpenMigratesProviderAuthToken(t *testing.T) {
	path := filepath.Join(t.TempDir(), "settings.json")
	raw := `{"providers":[{"id":"only-token","api_key":"","auth_token":"t1"},{"id":"both","api_key":"k1","auth_token":"t2"}]}`
	if err := os.WriteFile(path, []byte(raw), 0o600); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	s, err := Open(path)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	onlyToken, ok := s.Get().Provider("only-token")
	if !ok {
		t.Fatal("provider 应存在")
	}
	if onlyToken.APIKey != "t1" || onlyToken.Auth != AuthBearer {
		t.Fatalf("只有 Bearer 令牌时应挪成 bearer: %+v", onlyToken)
	}
	both, _ := s.Get().Provider("both")
	if both.APIKey != "k1" || both.Auth != AuthXAPIKey {
		t.Fatalf("两份都有时应以 APIKey 为准: %+v", both)
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
	// api_protocol 已废弃：旧的 openai-completions 值被忽略（协议恒为 Anthropic
	// Messages），迁移后那个键被清掉，下次写盘不会再留下它。
	if got.LegacyProtocol != "" {
		t.Fatalf("废弃的 api_protocol 应被清空: %q", got.LegacyProtocol)
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

func TestEnvUsesBearerWhenAuthIsBearer(t *testing.T) {
	v := Settings{
		Providers: []Provider{{ID: "g", BaseURL: "https://x", APIKey: "t1", Auth: AuthBearer, Models: []string{"m"}}},
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

// 默认认证方式（字段为空）是 x-api-key：旧配置与自定义中转都落在这里，
// 也是旧版对话注入的优先级。
func TestEnvDefaultsToXAPIKey(t *testing.T) {
	v := Settings{
		Providers: []Provider{{ID: "g", BaseURL: "https://x", APIKey: "sk-1", Models: []string{"m"}}},
		Selected:  Selection{Provider: "g", Model: "m"},
	}
	env := strings.Join(v.Env(), ",")
	if !strings.Contains(env, "ANTHROPIC_API_KEY=sk-1") {
		t.Fatalf("默认应使用 x-api-key: %v", env)
	}
	if strings.Contains(env, "ANTHROPIC_AUTH_TOKEN") {
		t.Fatalf("不应同时设置 AUTH_TOKEN: %v", env)
	}
}

// 旧配置把 Bearer 令牌单独存一份：加载时挪到唯一那把密钥上，并记成 bearer。
// 两份都有时以 APIKey 为准（旧版对话就是只注入 ANTHROPIC_API_KEY，Bearer 那份
// 其实没生效），不能反过来把 Bearer 令牌当成密钥。
func TestMigrateLegacyAuthToken(t *testing.T) {
	t.Run("只有 Bearer 令牌", func(t *testing.T) {
		v := Settings{Providers: []Provider{{ID: "g", LegacyAuthToken: "t1"}}}
		migrateProviders(&v)
		p := v.Providers[0]
		if p.APIKey != "t1" || p.Auth != AuthBearer {
			t.Fatalf("应合并成 bearer: %+v", p)
		}
		if p.LegacyAuthToken != "" {
			t.Fatal("迁移后旧键应清空")
		}
	})
	t.Run("两份都有", func(t *testing.T) {
		v := Settings{Providers: []Provider{{ID: "g", APIKey: "k1", LegacyAuthToken: "t1"}}}
		migrateProviders(&v)
		p := v.Providers[0]
		if p.APIKey != "k1" || p.Auth != AuthXAPIKey {
			t.Fatalf("应以 APIKey 为准: %+v", p)
		}
		if p.LegacyAuthToken != "" {
			t.Fatal("迁移后旧键应清空")
		}
	})
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

// base 是否带 /v1 由用户决定，两条路径都应该落到同一个地址：
// CLI 自己拼 /v1/messages，所以尾部的 /v1 必须剥掉。
func TestChatBaseURLStripsV1(t *testing.T) {
	cases := []struct {
		base, want string
	}{
		{"http://127.0.0.1:7863/v1", "http://127.0.0.1:7863"},
		{"http://127.0.0.1:7863/v1/", "http://127.0.0.1:7863"},
		{"https://gw.example/openai/v1", "https://gw.example/openai"},
		{"https://gw.example/v1beta", "https://gw.example/v1beta"},
		{"https://api.anthropic.com", "https://api.anthropic.com"},
		// 带 /v1 的 Anthropic 地址以前原样保留 → 变成 /v1/v1/messages，现在也剥。
		{"https://api.anthropic.com/v1", "https://api.anthropic.com"},
		{"https://api.deepseek.com/anthropic", "https://api.deepseek.com/anthropic"},
	}
	for _, c := range cases {
		p := Provider{BaseURL: c.base}
		if got := p.ChatBaseURL(); got != c.want {
			t.Fatalf("%s → %q, want %q", c.base, got, c.want)
		}
		// 列表地址与对话地址必须同源，否则就是「列表拉得到、对话 404」。
		if got, want := p.ListBaseURL(), p.ChatBaseURL(); got != want {
			t.Fatalf("%s: 列表 base %q 与对话 base %q 不一致", c.base, got, want)
		}
	}
}

func TestEnvUsesChatBaseURL(t *testing.T) {
	v := Settings{
		Providers: []Provider{{
			ID: "gw", BaseURL: "http://127.0.0.1:7863/v1",
			APIKey: "sk-1", Models: []string{"cn:deepseek"},
		}},
		Selected: Selection{Provider: "gw", Model: "cn:deepseek"},
	}
	env := strings.Join(v.Env(), ",")
	if !strings.Contains(env, "ANTHROPIC_BASE_URL=http://127.0.0.1:7863") {
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

// 429/额度耗尽不应让用户等几分钟：默认重试 10 次，这里压到 2 次并封顶单次等待。
func TestEnvFailsFastOnRateLimit(t *testing.T) {
	env := strings.Join(Settings{}.Env(), ",")
	for _, want := range []string{
		"CLAUDE_CODE_MAX_RETRIES=2",
		"CLAUDE_CODE_OVERLOADED_RETRY_MAX_WAIT_MS=5000",
		"CLAUDE_CODE_NONSTREAMING_TIMEOUT_RETRIES=0",
	} {
		if !strings.Contains(env, want) {
			t.Fatalf("缺少 %s: %v", want, env)
		}
	}
}

// 上游一个字节都不回时的判定阈值压到 60s（默认 5 分钟，见 Settings.Env 的注释）。
//
// 关键是不能写成 CLAUDE_STREAM_IDLE_TIMEOUT_MS：它被 CLI 抬到 300000 下限，
// 设 60s 等于把 firstParty 的 180s 默认值改成 5 分钟，比不设还慢（实测 2.1.329）。
func TestEnvSetsByteStreamIdleTimeout(t *testing.T) {
	env := strings.Join(Settings{}.Env(), ",")
	if !strings.Contains(env, "CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS=60000") {
		t.Fatalf("缺少字节流空闲阈值: %v", env)
	}
	if strings.Contains(env, "CLAUDE_STREAM_IDLE_TIMEOUT_MS=") {
		t.Fatalf("不该碰 CLAUDE_STREAM_IDLE_TIMEOUT_MS（有 300000 下限，设小反而更慢）: %v", env)
	}
}

// 模型回退必须无条件关掉：CLI 会在好几条路径上悄悄换模型（可用性回退链、
// 积分 consent gate、拒答回退）。界面上写着「当前模型」就必须真的是那个模型——
// 换个模型重试对用户是不可见的行为改变，不能靠「ANTHROPIC_DEFAULT_* 恰好都指向
// 同一个模型」这种巧合来保证（配了第二个模型就会重新长出回退）。
func TestEnvDisablesModelFallback(t *testing.T) {
	// 没有选中模型时也必须注入：回退是 CLI 的行为，与有没有配 provider 无关。
	for _, v := range []Settings{
		{},
		{
			Providers: []Provider{{ID: "gw", Models: []string{"m1"}}},
			Selected:  Selection{Provider: "gw", Model: "m1"},
		},
	} {
		env := strings.Join(v.Env(), ",")
		if !strings.Contains(env, "CLAUDE_CODE_NO_MODEL_FALLBACK=1") {
			t.Fatalf("没有关掉模型回退: %v", env)
		}
	}
}

// 子代理模型：按提供商存一个，注入 CLAUDE_CODE_SUBAGENT_MODEL；模型被移除时跟着清空。
//
// 它只是**默认值**：CLI 的解析顺序是 调用参数 > 定义里的 model > 本变量 > 主对话模型，
// 所以不能把它当成「强制所有子代理用这个模型」——那需要 _FORCE，会连用户的 agent 定义一起盖掉。
func TestSubagentModelEnvAndPrune(t *testing.T) {
	s, path := openTemp(t)
	// 没有选中提供商时一个字节都不注入（空值会让 CLI 的继承链断在这里）。
	if env := strings.Join(Settings{}.Env(), ","); strings.Contains(env, "CLAUDE_CODE_SUBAGENT_MODEL") {
		t.Fatalf("未指定子代理模型却注入了变量: %v", env)
	}

	providers := []ProviderPatch{{
		ID:            "gw",
		BaseURL:       "https://gw.example/anthropic",
		APIKey:        "k",
		Models:        []string{"m1", "m2"},
		SubagentModel: strPtr("m2"),
	}}
	if _, err := s.Apply(Patch{
		Providers: &providers,
		Selected:  &Selection{Provider: "gw", Model: "m1"},
	}); err != nil {
		t.Fatalf("Apply: %v", err)
	}

	reopened, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	if got := reopened.Get().Providers[0].SubagentModel; got != "m2" {
		t.Fatalf("重开后 SubagentModel = %q", got)
	}
	if got := reopened.Public().Providers[0].SubagentModel; got != "m2" {
		t.Fatalf("Public 里 = %q", got)
	}
	if env := strings.Join(reopened.Get().Env(), ","); !strings.Contains(env, "CLAUDE_CODE_SUBAGENT_MODEL=m2") {
		t.Fatalf("缺少 CLAUDE_CODE_SUBAGENT_MODEL: %v", env)
	}

	// 旧前端包（浏览器缓存里还没这个字段）保存提供商时不能把选择抹掉：
	// 与 Auth 的「空串=沿用旧值」同一类坑，这里用 nil 表示「没带这个字段」。
	legacy := []ProviderPatch{{ID: "gw", BaseURL: "https://gw.example/anthropic", Models: []string{"m1", "m2"}}}
	if _, err := s.Apply(Patch{Providers: &legacy}); err != nil {
		t.Fatalf("Apply: %v", err)
	}
	if got := s.Get().Providers[0].SubagentModel; got != "m2" {
		t.Fatalf("旧前端保存后 SubagentModel 应沿用 %q，实际 %q", "m2", got)
	}

	// 显式空串才是清除（新前端选「不指定」走这条路）。
	cleared := []ProviderPatch{{ID: "gw", BaseURL: "https://gw.example/anthropic", Models: []string{"m1", "m2"}, SubagentModel: strPtr("")}}
	if _, err := s.Apply(Patch{Providers: &cleared}); err != nil {
		t.Fatalf("Apply: %v", err)
	}
	if got := s.Get().Providers[0].SubagentModel; got != "" {
		t.Fatalf("显式清空后应变成空串，实际 %q", got)
	}

	// 删掉被选中的那个模型：悬空的 ID 会让 CLI 派不出子代理，必须跟着清空。
	if _, err := s.Apply(Patch{Providers: &[]ProviderPatch{{
		ID: "gw", BaseURL: "https://gw.example/anthropic", Models: []string{"m1", "m2"}, SubagentModel: strPtr("m2"),
	}}}); err != nil {
		t.Fatalf("Apply: %v", err)
	}
	same := []ProviderPatch{{ID: "gw", BaseURL: "https://gw.example/anthropic", Models: []string{"m1"}, SubagentModel: strPtr("m2")}}
	if _, err := s.Apply(Patch{Providers: &same}); err != nil {
		t.Fatalf("Apply: %v", err)
	}
	if got := s.Get().Providers[0].SubagentModel; got != "" {
		t.Fatalf("模型被移除后 SubagentModel 应清空，实际 %q", got)
	}
	if env := strings.Join(s.Get().Env(), ","); strings.Contains(env, "CLAUDE_CODE_SUBAGENT_MODEL") {
		t.Fatalf("清空后仍注入了变量: %v", env)
	}
}

// 手改 settings.json 写出一个已经不在模型列表里的子代理模型：Open 时自愈，
// 否则 Public 会把它回给前端（下拉里显示成空），Env 会把它交给 CLI（派子代理 404）。
func TestSubagentModelDanglingHealedOnOpen(t *testing.T) {
	s, path := openTemp(t)
	if _, err := s.Apply(Patch{Providers: &[]ProviderPatch{{
		ID: "gw", BaseURL: "https://gw.example/anthropic", Models: []string{"m1"}, SubagentModel: strPtr("m1"),
	}}}); err != nil {
		t.Fatalf("Apply: %v", err)
	}

	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var cfg Settings
	if err := json.Unmarshal(raw, &cfg); err != nil {
		t.Fatal(err)
	}
	cfg.Providers[0].SubagentModel = "gone"
	edited, err := json.Marshal(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, edited, 0o600); err != nil {
		t.Fatal(err)
	}

	reopened, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	if got := reopened.Get().Providers[0].SubagentModel; got != "" {
		t.Fatalf("悬空的 SubagentModel 应在 Open 时清空，实际 %q", got)
	}
	if env := strings.Join(reopened.Get().Env(), ","); strings.Contains(env, "CLAUDE_CODE_SUBAGENT_MODEL") {
		t.Fatalf("悬空值不应注入: %v", env)
	}
}

func TestModelMetaAndEffort(t *testing.T) {
	s, _ := openTemp(t)
	if _, err := s.Apply(Patch{
		Providers: &[]ProviderPatch{{
			ID:     "gw",
			Models: []string{"m1", "m2"},
			ModelMeta: map[string]ModelSpec{
				"m1": {Name: "模型一", ReasoningEfforts: []string{"low", "high"}, SupportsImage: true, ContextWindow: 1000000, MaxOutputTokens: 128000},
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
	if spec.Name != "模型一" || !spec.SupportsImage {
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

	// 未选择（空串）= 默认档：不向 API 声明推理等级；未声明的档位一律归一到默认。
	for _, tc := range []struct{ selected, want string }{
		{"", ""},
		{"high", "high"},
		{"nope", ""},
	} {
		if _, err := s.Apply(Patch{Selected: &Selection{Provider: "gw", Model: "m1", Effort: tc.selected}}); err != nil {
			t.Fatalf("Apply(%q): %v", tc.selected, err)
		}
		if eff := s.Get().DefaultEffort(); eff != tc.want {
			t.Fatalf("选中的 %q 应归一成 %q，实际 %q", tc.selected, tc.want, eff)
		}
	}
}

func TestEffortClearedForModelWithoutLevels(t *testing.T) {
	s, _ := openTemp(t)
	if _, err := s.Apply(Patch{
		Providers: &[]ProviderPatch{{
			ID: "gw", Models: []string{"m1", "m2"},
			ModelMeta: map[string]ModelSpec{"m1": {ReasoningEfforts: []string{"low", "high"}}, "m2": {}},
		}},
		Selected: &Selection{Provider: "gw", Model: "m2", Effort: "high"},
	}); err != nil {
		t.Fatalf("Apply: %v", err)
	}
	// 没有声明档位的模型不暴露档位，残留值要被清掉。
	if eff := s.Get().DefaultEffort(); eff != "" {
		t.Fatalf("未声明档位时应为空，实际 %q", eff)
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
	if got.Locale != DefaultLocale || got.FontSize != DefaultFontSize {
		t.Fatalf("默认界面偏好 = %+v", got)
	}
	locale, size := "en", 17
	if _, err := s.Apply(Patch{Locale: &locale, FontSize: &size}); err != nil {
		t.Fatalf("Apply: %v", err)
	}
	reopened, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	got = reopened.Get()
	if got.Locale != "en" || got.FontSize != 17 {
		t.Fatalf("重开后偏好 = %+v", got)
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

// 空闲回收阈值：默认 10 分钟、改完落盘、越界拒绝，坏配置文件回落默认值。
//
// 它决定 manager 多久回收一次常驻进程，所以「读回来的值」必须永远落在
// 合法区间内——手改 settings.json 写个 0 或 999 不能让回收循环疯转或永不触发。
func TestIdleMinutesDefaultsAndValidation(t *testing.T) {
	s, path := openTemp(t)
	if got := s.IdleMinutes(); got != DefaultIdleMinutes {
		t.Fatalf("默认空闲回收 = %d, want %d", got, DefaultIdleMinutes)
	}
	if got := s.Public().IdleMinutes; got != DefaultIdleMinutes {
		t.Fatalf("Public 里的默认值 = %d", got)
	}

	want := 25
	if _, err := s.Apply(Patch{IdleMinutes: &want}); err != nil {
		t.Fatalf("Apply: %v", err)
	}
	reopened, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	if got := reopened.IdleMinutes(); got != want {
		t.Fatalf("重开后 = %d, want %d", got, want)
	}

	for _, bad := range []int{0, 4, 61, -1} {
		v := bad
		if _, err := s.Apply(Patch{IdleMinutes: &v}); err == nil {
			t.Fatalf("%d 分钟应被拒绝", bad)
		}
	}
}

// 常驻会话数：默认 8、范围 6–12、改完落盘、越界拒绝、坏配置文件回落默认值。
//
// 它决定 manager 最多同时养几个 claude 子进程，所以「读回来的值」必须永远落在
// 合法区间内——手改 settings.json 写个 0 会让所有新建会话都被 ErrTooMany 挡住。
func TestMaxSessionsDefaultsAndValidation(t *testing.T) {
	s, path := openTemp(t)
	if got := s.MaxSessions(); got != DefaultMaxSessions {
		t.Fatalf("默认常驻会话数 = %d, want %d", got, DefaultMaxSessions)
	}
	if got := s.Public().MaxSessions; got != DefaultMaxSessions {
		t.Fatalf("Public 里的默认值 = %d", got)
	}

	want := 12
	if _, err := s.Apply(Patch{MaxSessions: &want}); err != nil {
		t.Fatalf("Apply: %v", err)
	}
	reopened, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	if got := reopened.MaxSessions(); got != want {
		t.Fatalf("重开后 = %d, want %d", got, want)
	}

	for _, bad := range []int{0, 5, 13, -2} {
		v := bad
		if _, err := s.Apply(Patch{MaxSessions: &v}); err == nil {
			t.Fatalf("%d 个常驻会话应被拒绝", bad)
		}
	}
}

// 手改配置文件写出的越界值不能让「一个会话都起不来」：Open 时回落默认值。
func TestMaxSessionsBadConfigFallsBack(t *testing.T) {
	path := filepath.Join(t.TempDir(), "settings.json")
	if err := os.WriteFile(path, []byte(`{"max_sessions": 0}`), 0o600); err != nil {
		t.Fatal(err)
	}
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	if got := s.MaxSessions(); got != DefaultMaxSessions {
		t.Fatalf("越界配置应回落默认值，实际 %d", got)
	}
}

// 子代理规模：默认值刻意比 CLI 原生的小（10 并发 / 1 层），改完落盘，
// 越界拒绝，坏配置文件回落默认值；两个值都必须无条件注入环境变量。
func TestSubagentLimitsDefaultsAndEnv(t *testing.T) {
	s, path := openTemp(t)
	if got := s.Get().SubagentMaxConcurrentValue(); got != DefaultSubagentMaxConcurrent {
		t.Fatalf("默认并发上限 = %d, want %d", got, DefaultSubagentMaxConcurrent)
	}
	if got := s.Get().SubagentSpawnDepthValue(); got != DefaultSubagentSpawnDepth {
		t.Fatalf("默认递归深度 = %d, want %d", got, DefaultSubagentSpawnDepth)
	}
	pub := s.Public()
	if pub.SubagentMaxConcurrent != DefaultSubagentMaxConcurrent || pub.SubagentSpawnDepth != DefaultSubagentSpawnDepth {
		t.Fatalf("Public 里的默认值 = %d/%d", pub.SubagentMaxConcurrent, pub.SubagentSpawnDepth)
	}
	// 零值配置（没跑过 Open 的 Settings{}）也要注入合法值：0 会让 CLI
	// 一个子代理都派不出来。
	env := strings.Join(Settings{}.Env(), ",")
	for _, want := range []string{
		fmt.Sprintf("CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS=%d", DefaultSubagentMaxConcurrent),
		fmt.Sprintf("CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=%d", DefaultSubagentSpawnDepth),
	} {
		if !strings.Contains(env, want) {
			t.Fatalf("Env 缺少 %q: %v", want, env)
		}
	}

	concurrent, depth := 30, 4
	if _, err := s.Apply(Patch{SubagentMaxConcurrent: &concurrent, SubagentSpawnDepth: &depth}); err != nil {
		t.Fatalf("Apply: %v", err)
	}
	reopened, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	env = strings.Join(reopened.Get().Env(), ",")
	for _, want := range []string{
		"CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS=30",
		"CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=4",
	} {
		if !strings.Contains(env, want) {
			t.Fatalf("重开后 Env 缺少 %q: %v", want, env)
		}
	}

	for _, bad := range []int{0, -1, MaxSubagentMaxConcurrent + 1} {
		v := bad
		if _, err := s.Apply(Patch{SubagentMaxConcurrent: &v}); err == nil {
			t.Fatalf("并发上限 %d 应被拒绝", bad)
		}
	}
	for _, bad := range []int{0, -1, MaxSubagentSpawnDepth + 1} {
		v := bad
		if _, err := s.Apply(Patch{SubagentSpawnDepth: &v}); err == nil {
			t.Fatalf("递归深度 %d 应被拒绝", bad)
		}
	}

	// 手改配置写出越界值：读回来必须是默认值，不能让 0 或 999 进 CLI。
	var raw Settings
	raw.SubagentMaxConcurrent = 999
	raw.SubagentSpawnDepth = -3
	normalizePreferences(&raw)
	if raw.SubagentMaxConcurrent != DefaultSubagentMaxConcurrent || raw.SubagentSpawnDepth != DefaultSubagentSpawnDepth {
		t.Fatalf("越界值没回落默认: %d/%d", raw.SubagentMaxConcurrent, raw.SubagentSpawnDepth)
	}
}

func TestProxyURLPersistAndEnv(t *testing.T) {
	s, path := openTemp(t)
	if _, err := s.Apply(Patch{ProxyURL: strPtr("http://127.0.0.1:7890")}); err != nil {
		t.Fatalf("Apply: %v", err)
	}
	reopened, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	if got := reopened.Get().ProxyURL; got != "http://127.0.0.1:7890" {
		t.Fatalf("ProxyURL = %q", got)
	}
	env := strings.Join(reopened.Get().Env(), ",")
	for _, want := range []string{
		"HTTPS_PROXY=http://127.0.0.1:7890",
		"ALL_PROXY=http://127.0.0.1:7890",
		"NO_PROXY=localhost,127.0.0.1,::1",
		"NODE_USE_ENV_PROXY=1",
	} {
		if !strings.Contains(env, want) {
			t.Fatalf("Env 缺少 %q: %v", want, env)
		}
	}
	// SOCKS 变量不再注入：设置层只接受 HTTP 代理，留一份 SOCKS_PROXY 只会误导。
	if strings.Contains(env, "SOCKS_PROXY") {
		t.Fatalf("不应注入 SOCKS_PROXY: %v", env)
	}
	// 清空代理后不应再注入代理变量。
	if _, err := s.Apply(Patch{ProxyURL: strPtr("")}); err != nil {
		t.Fatal(err)
	}
	if env := strings.Join(s.Get().Env(), ","); strings.Contains(env, "PROXY=") {
		t.Fatalf("空代理仍注入变量: %v", env)
	}
}

// 手改配置留下的 socks5:// 必须在 Open 时丢掉：claude 拿到它每一轮都报
// `Unable to connect to API (UnsupportedProxyProtocol)`，比直连更糟。
func TestSocksProxyDroppedOnOpen(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "settings.json")
	if err := os.WriteFile(path, []byte(`{"proxy_url":"socks5://127.0.0.1:1080"}`), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	if got := s.Get().ProxyURL; got != "" {
		t.Fatalf("socks5 应被丢弃，得到 %q", got)
	}
	if env := strings.Join(s.Get().Env(), ","); strings.Contains(env, "PROXY=") {
		t.Fatalf("丢弃后不应注入代理变量: %v", env)
	}
}

func TestProxyURLValidation(t *testing.T) {
	if got, err := NormalizeProxyURL(""); err != nil || got != "" {
		t.Fatalf("空串 = %q, %v", got, err)
	}
	for _, ok := range []string{"http://127.0.0.1:7890", "https://proxy.example:443", "http://user:pass@127.0.0.1:7890"} {
		if _, err := NormalizeProxyURL(ok); err != nil {
			t.Fatalf("%q 应合法: %v", ok, err)
		}
	}
	// SOCKS 与其它协议一律拒绝（claude 只认 HTTP 代理）。
	for _, bad := range []string{"127.0.0.1:1080", "ftp://x:1", "socks5://", "http://",
		"socks5://127.0.0.1:1080", "socks5h://proxy.example:1080", "socks4://x:1"} {
		if _, err := NormalizeProxyURL(bad); err == nil {
			t.Fatalf("%q 应被拒绝", bad)
		}
	}
	s, _ := openTemp(t)
	if _, err := s.Apply(Patch{ProxyURL: strPtr("socks5://127.0.0.1:1080")}); err == nil {
		t.Fatal("SOCKS 代理应报错")
	}
}

// 主题只缓存在浏览器：settings.json 里不该再有 theme；旧文件里的 theme 在下次写盘时消失。
func TestThemeNotPersisted(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "settings.json")
	if err := os.WriteFile(path, []byte(`{"theme":"dark","locale":"en"}`), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	s, err := Open(path)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	// 旧配置里的 theme 读进来也不认（结构体已经没有这个字段）。
	if got := s.Public(); strings.Contains(mustJSON(t, got), "theme") {
		t.Fatalf("Public 不应包含 theme: %s", mustJSON(t, got))
	}

	locale := "zh"
	if _, err := s.Apply(Patch{Locale: &locale}); err != nil {
		t.Fatalf("Apply: %v", err)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if strings.Contains(string(raw), `"theme"`) {
		t.Fatalf("写盘后仍带 theme: %s", raw)
	}
}

func mustJSON(t *testing.T, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return string(b)
}

func TestSearchSettingsDefaultsAndPatch(t *testing.T) {
	s, path := openTemp(t)
	// 老配置没有这几个字段：补默认值，而不是留空（空基地址会让「测试连接」直接报错）。
	if got := s.Get().SearchBaseURL; got != DefaultSearchBaseURL {
		t.Fatalf("默认基地址 = %q", got)
	}
	if got := s.Get().SearchCount; got != DefaultSearchCount {
		t.Fatalf("默认条数 = %d", got)
	}

	base := "https://gw.example.com/api/v1/tools/"
	key := "sk-test-1"
	count := 20
	enabled := true
	pub, err := s.Apply(Patch{SearchBaseURL: &base, SearchAPIKey: &key, SearchCount: &count, SearchEnabled: &enabled})
	if err != nil {
		t.Fatalf("Apply: %v", err)
	}
	// 尾斜杠要去掉，否则客户端会拼出 //search。
	if pub.SearchBaseURL != "https://gw.example.com/api/v1/tools" {
		t.Fatalf("基地址 = %q", pub.SearchBaseURL)
	}
	if !pub.SearchAPIKeySet || pub.SearchAPIKeyMask != Mask(key) {
		t.Fatalf("密钥脱敏 = %q / set=%v", pub.SearchAPIKeyMask, pub.SearchAPIKeySet)
	}
	if pub.SearchCount != 20 || !pub.SearchEnabled {
		t.Fatalf("条数/开关 = %d/%v", pub.SearchCount, pub.SearchEnabled)
	}
	// 落盘后重新打开仍在。
	re, err := Open(path)
	if err != nil {
		t.Fatalf("重新打开: %v", err)
	}
	if re.Get().SearchAPIKey != key {
		t.Fatalf("密钥没落盘")
	}

	// 空串=沿用旧值，清空必须显式 clear。
	empty := ""
	if _, err := s.Apply(Patch{SearchAPIKey: &empty}); err != nil {
		t.Fatalf("Apply 空密钥: %v", err)
	}
	if s.Get().SearchAPIKey != key {
		t.Fatalf("空串不该清空密钥")
	}
	clearTrue := true
	pub, err = s.Apply(Patch{SearchClearKey: &clearTrue})
	if err != nil || pub.SearchAPIKeySet {
		t.Fatalf("clear_search_key 没生效: %v %v", err, pub.SearchAPIKeySet)
	}
}

func TestSearchSettingsValidation(t *testing.T) {
	s, _ := openTemp(t)
	bad := "ftp://x"
	if _, err := s.Apply(Patch{SearchBaseURL: &bad}); err == nil {
		t.Fatalf("非 http(s) 基地址应当报错")
	}
	tooMany := 51
	if _, err := s.Apply(Patch{SearchCount: &tooMany}); err == nil {
		t.Fatalf("条数 51 应当报错")
	}
	zero := 0
	if _, err := s.Apply(Patch{SearchCount: &zero}); err == nil {
		t.Fatalf("条数 0 应当报错")
	}
}

// TCP 直连访问：默认关闭、默认 3141；开启必须带合规密码，落盘只有摘要。
func TestTCPAccessDefaults(t *testing.T) {
	s, _ := openTemp(t)
	got := s.Get()
	if got.TCPEnabled {
		t.Fatal("端口访问默认必须关闭")
	}
	if got.TCPPort != DefaultTCPPort {
		t.Fatalf("TCPPort = %d, want %d", got.TCPPort, DefaultTCPPort)
	}
	if got.TCPPasswordHash != "" {
		t.Fatal("默认不应有密码摘要")
	}
	if got.LoginTTLHours != DefaultLoginTTLHours {
		t.Fatalf("LoginTTLHours = %d, want %d", got.LoginTTLHours, DefaultLoginTTLHours)
	}
	pub := s.Public()
	if pub.TCPEnabled || pub.TCPPasswordSet || pub.TCPPort != DefaultTCPPort {
		t.Fatalf("Public 默认值不对: %+v", pub)
	}
	if pub.LoginTTLHours != DefaultLoginTTLHours {
		t.Fatalf("Public.LoginTTLHours = %d, want %d", pub.LoginTTLHours, DefaultLoginTTLHours)
	}
	if ttl := s.LoginTTL(); ttl != DefaultLoginTTLHours*time.Hour {
		t.Fatalf("LoginTTL() = %v, want %v", ttl, DefaultLoginTTLHours*time.Hour)
	}
}

// 登录有效期 12–72 小时，越界直接报错；落盘后重启仍然读得回来。
func TestLoginTTLHours(t *testing.T) {
	s, path := openTemp(t)
	for _, bad := range []int{11, 0, 73, -24} {
		v := bad
		if _, err := s.Apply(Patch{LoginTTLHours: &v}); err == nil {
			t.Fatalf("有效期 %d 小时应当报错", bad)
		}
	}
	v := 48
	pub, err := s.Apply(Patch{LoginTTLHours: &v})
	if err != nil {
		t.Fatalf("Apply: %v", err)
	}
	if pub.LoginTTLHours != 48 {
		t.Fatalf("Public.LoginTTLHours = %d, want 48", pub.LoginTTLHours)
	}
	reopened, err := Open(path)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if got := reopened.LoginTTL(); got != 48*time.Hour {
		t.Fatalf("重启后 LoginTTL() = %v, want 48h", got)
	}
}

// 手改配置文件写了越界值要回落默认：0 会让令牌一签发就过期。
func TestLoginTTLNormalize(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "settings.json")
	if err := os.WriteFile(path, []byte(`{"login_ttl_hours": 500}`), 0o600); err != nil {
		t.Fatal(err)
	}
	s, err := Open(path)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if got := s.Get().LoginTTLHours; got != DefaultLoginTTLHours {
		t.Fatalf("越界值应回落默认: %d", got)
	}
}

func TestTCPAccessRequiresStrongPassword(t *testing.T) {
	s, path := openTemp(t)
	on := true
	if _, err := s.Apply(Patch{TCPEnabled: &on}); err == nil {
		t.Fatal("没有密码时开启端口访问应当报错")
	}
	for _, weak := range []string{"short", "allletters", "12345678"} {
		pwd := weak
		if _, err := s.Apply(Patch{TCPEnabled: &on, TCPPassword: &pwd}); err == nil {
			t.Fatalf("弱密码 %q 应当报错", weak)
		}
	}

	pwd := "s3cret-123"
	port := 4040
	pub, err := s.Apply(Patch{TCPEnabled: &on, TCPPort: &port, TCPPassword: &pwd})
	if err != nil {
		t.Fatalf("Apply: %v", err)
	}
	if !pub.TCPEnabled || pub.TCPPort != 4040 || !pub.TCPPasswordSet {
		t.Fatalf("Public = %+v", pub)
	}

	got := s.Get()
	if got.TCPPasswordHash == "" {
		t.Fatal("密码摘要没落盘")
	}
	if strings.Contains(got.TCPPasswordHash, pwd) {
		t.Fatalf("摘要里出现了明文: %s", got.TCPPasswordHash)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), pwd) {
		t.Fatalf("settings.json 里有明文密码: %s", raw)
	}
	pubJSON, _ := json.Marshal(pub)
	if strings.Contains(string(pubJSON), got.TCPPasswordHash) {
		t.Fatalf("Public 回传了密码摘要: %s", pubJSON)
	}

	re, err := Open(path)
	if err != nil {
		t.Fatalf("重新打开: %v", err)
	}
	if reloaded := re.Get(); !reloaded.TCPEnabled || !authz.VerifyPassword(reloaded.TCPPasswordHash, pwd) {
		t.Fatalf("落盘后无法用原密码登录: %+v", reloaded)
	}

	// 空串=沿用旧密码（与其它密钥一致）。
	empty := ""
	if _, err := s.Apply(Patch{TCPPassword: &empty}); err != nil {
		t.Fatalf("Apply 空密码: %v", err)
	}
	if s.Get().TCPPasswordHash != got.TCPPasswordHash {
		t.Fatal("空串不该改密码")
	}

	// 关闭端口访问后密码可以保留，供下次开启直接使用。
	off := false
	if _, err := s.Apply(Patch{TCPEnabled: &off}); err != nil {
		t.Fatalf("关闭: %v", err)
	}
	if s.Get().TCPEnabled {
		t.Fatal("应当已关闭")
	}
	if s.Get().TCPPasswordHash == "" {
		t.Fatal("关闭后不应丢掉密码")
	}
}

func TestTCPPortValidation(t *testing.T) {
	s, _ := openTemp(t)
	on := true
	pwd := "s3cret-123"
	if _, err := s.Apply(Patch{TCPPassword: &pwd}); err != nil {
		t.Fatalf("设置密码: %v", err)
	}
	for _, port := range []int{0, 1024, 70000} {
		p := port
		if _, err := s.Apply(Patch{TCPPort: &p, TCPEnabled: &on}); err == nil {
			t.Fatalf("端口 %d 应当报错", port)
		}
	}
	if s.Get().TCPPort != DefaultTCPPort || s.Get().TCPEnabled {
		t.Fatalf("失败的 Apply 不该改动内存态: %+v", s.Get())
	}
	// 1025 是允许的最小端口。
	min := MinTCPPort
	if _, err := s.Apply(Patch{TCPPort: &min, TCPEnabled: &on}); err != nil {
		t.Fatalf("端口 %d 应当允许: %v", min, err)
	}
	if got := s.Get(); got.TCPPort != min || !got.TCPEnabled {
		t.Fatalf("端口 %d 没生效: %+v", min, got)
	}
}

// 「开启但没有密码摘要」的坏配置读进来要回落成关闭，否则连登录都做不到。
func TestNormalizeDisablesEnabledWithoutHash(t *testing.T) {
	path := filepath.Join(t.TempDir(), "settings.json")
	body := `{"tcp_enabled":true,"tcp_port":4141}`
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	s, err := Open(path)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	got := s.Get()
	if got.TCPEnabled {
		t.Fatalf("无密码的坏配置应回落成关闭: %+v", got)
	}
	if got.TCPPort != 4141 {
		t.Fatalf("端口应保留: %d", got.TCPPort)
	}
}
