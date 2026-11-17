package gateway

import (
	"encoding/json"
)

// systemTopic 是应用级事件的保留 topic。
//
// 会话 id 都是 claude 生成的 UUID，不可能等于这个名字；不带 ?id 的 /ws 连接
// 订阅它，因此「没有打开任何对话」的标签页也能收到更新提示。
const systemTopic = "__system__"

// BroadcastClaudeUpdate 在「有新版可用」时把提示推给所有打开的面板。
//
// 推送只带版本号，前端收到后照旧调 /api/claude/status 拿完整快照：状态里还有
// 已安装列表、生效版本与安装进度，重复实现一份解析只会两边不一致。
//
// 同一个最新版本只推一次：每小时检查都推一遍的话，每个标签页每小时都会多发一次
// status 请求，而内容一字未变。装上或切到该版本后 UpdateAvailable 变 false，
// 这里顺手清掉去重标记，同一个版本号以后再出现仍然会推。
func (s *Server) BroadcastClaudeUpdate() {
	if s.d.Claude == nil {
		return
	}
	st := s.d.Claude.Status()
	if st.Active == "" || !st.UpdateAvailable {
		s.notifiedMu.Lock()
		s.notifiedLatest = ""
		s.notifiedMu.Unlock()
		return
	}

	s.notifiedMu.Lock()
	if s.notifiedLatest == st.Latest {
		s.notifiedMu.Unlock()
		return
	}
	s.notifiedLatest = st.Latest
	s.notifiedMu.Unlock()

	data, err := json.Marshal(map[string]string{"active": st.Active, "latest": st.Latest})
	if err != nil {
		return
	}
	s.d.Hub.Broadcast(systemTopic, WireEvent{Kind: "claude.update", Data: data})
}
