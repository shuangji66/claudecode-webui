package gateway

import "ccweb/backend/internal/mcp"

// SessionToolRules 按「用户级配置里现在到底有哪些内置服务」算一套会话工具规则。
//
// 三条内置服务（内置搜索 / 自动化任务 / 内置浏览器）共用这一份：谁真的在配置里就放行谁
// 的工具、顺带禁掉会被它抢选择的原生工具，不在就一条都不加。放行一个不存在的工具只是
// 一条空规则，但**把内置的 WebSearch/WebFetch 禁掉却换不上任何搜索工具**会让模型彻底
// 丧失联网能力——这正是这组规则必须「看见才加」的原因。
//
// `user` 是 `mcp.Manager.List` 的用户级列表，**里面含「停用暂存」的条目**（`Disabled`
// 为 true，界面要能看到并重新启用）。停用的服务已经被摘出 claude 的配置，会话根本连不上，
// 所以这里必须把它们当成不存在：只看「列表里有这一条」的话，用户在 MCP 页停用内置搜索
// 之后就变成「搜索没了、内置的也被挡了」——一条工具都不剩。
func SessionToolRules(user []mcp.Server, searchEnabled bool) (allow, deny []string) {
	for _, srv := range user {
		// 只认用户级的那几条：项目级 `.mcp.json` 里可以有同名服务（命令完全不同），
		// 放行它等于给一个我们不认识的进程开免审批。
		if srv.Disabled || srv.Scope != mcp.ScopeUser {
			continue
		}
		switch srv.Name {
		case SearchMCPServer:
			// 停用之外还要看总开关：只有用户真的启用了搜索才放行、才禁内置的两个。
			if searchEnabled {
				a, d := SearchToolRules()
				allow = append(allow, a...)
				deny = append(deny, d...)
			}
		case ScheduleMCPServer:
			// 自动化任务的三个工具：注册了才放行（同样是为了不每建一条弹一次审批）。
			allow = append(allow, ScheduleToolRules()...)
		case BrowserMCPServer:
			// 内置浏览器的十个工具：每一步点击都弹审批的话，用户只会去切「跳过权限」，
			// 那等于把所有工具一起放开。收尾靠工具描述里的 browser_close 契约。
			allow = append(allow, BrowserToolRules()...)
		}
	}
	return allow, deny
}
