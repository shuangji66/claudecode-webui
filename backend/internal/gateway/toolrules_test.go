package gateway

import (
	"testing"

	"ccweb/backend/internal/mcp"
)

// 会话工具规则的唯一条件：**这条服务真的在 claude 的配置里**。
//
// `mcp.Manager.List` 会把「停用暂存」里的条目一起列出来（界面要能看到并重新启用），
// 只按名字匹配就会把停用的服务当成还在——内置搜索停用之后 `deny` 仍会挡掉
// WebSearch/WebFetch，而放行的 mcp__ccweb-web__* 根本不存在，模型一条联网工具都不剩。
func TestSessionToolRulesIgnoresDisabledServers(t *testing.T) {
	search := mcp.Server{Name: SearchMCPServer, Scope: mcp.ScopeUser, Disabled: true}
	schedule := mcp.Server{Name: ScheduleMCPServer, Scope: mcp.ScopeUser, Disabled: true}
	browser := mcp.Server{Name: BrowserMCPServer, Scope: mcp.ScopeUser, Disabled: true}

	allow, deny := SessionToolRules([]mcp.Server{search, schedule, browser}, true)
	if len(allow) != 0 || len(deny) != 0 {
		t.Fatalf("停用的服务不该产生任何规则: allow=%v deny=%v", allow, deny)
	}

	// 项目级条目（同名）同样不算：规则只认用户级那几条内置服务。
	project := mcp.Server{Name: SearchMCPServer, Scope: mcp.ScopeProject}
	if allow, deny := SessionToolRules([]mcp.Server{project}, true); len(allow) != 0 || len(deny) != 0 {
		t.Fatalf("项目级同名条目不该产生规则: allow=%v deny=%v", allow, deny)
	}
}

// 启用中的内置搜索：放行两个 MCP 工具，同时禁掉会被它抢选择的原生工具。
func TestSessionToolRulesForActiveSearch(t *testing.T) {
	user := []mcp.Server{{Name: SearchMCPServer, Scope: mcp.ScopeUser}}
	allow, deny := SessionToolRules(user, true)
	if len(allow) != len(searchAllowedTools) {
		t.Fatalf("allow = %v", allow)
	}
	for i, name := range searchAllowedTools {
		if allow[i] != name {
			t.Fatalf("allow = %v，想要 %v", allow, searchAllowedTools)
		}
	}
	if len(deny) != 2 || deny[0] != "WebSearch" || deny[1] != "WebFetch" {
		t.Fatalf("deny = %v", deny)
	}

	// 总开关关掉时搜索那条一条规则都不加：否则内置的 WebSearch/WebFetch 被挡掉、
	// 换上的 mcp 工具又因为 `search_enabled=false` 自己拒绝执行。
	if allow, deny := SessionToolRules(user, false); len(allow) != 0 || len(deny) != 0 {
		t.Fatalf("搜索没启用时不该有任何规则: allow=%v deny=%v", allow, deny)
	}
}

// 自动化任务与内置浏览器的工具同样「注册了才放行」——每一步都弹审批的话，
// 用户只会去切「跳过权限」，那等于把所有工具一起放开。
func TestSessionToolRulesForScheduleAndBrowser(t *testing.T) {
	user := []mcp.Server{
		{Name: ScheduleMCPServer, Scope: mcp.ScopeUser},
		{Name: BrowserMCPServer, Scope: mcp.ScopeUser},
	}
	allow, deny := SessionToolRules(user, false)
	if len(deny) != 0 {
		t.Fatalf("搜索没注册时不该有 deny: %v", deny)
	}
	want := len(ScheduleToolRules()) + len(BrowserToolRules())
	if len(allow) != want {
		t.Fatalf("allow 应有 %d 条，实际 %d: %v", want, len(allow), allow)
	}
}
