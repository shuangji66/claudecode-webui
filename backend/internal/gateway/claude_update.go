package gateway

import (
	"encoding/json"
)

// systemTopic 是应用级事件的保留 topic。
//
// 会话 id 都是 claude 生成的 UUID，不可能等于这个名字；不带 ?id 的 /ws 连接
// 订阅它，因此「没有打开任何对话」的标签页也能收到更新提示。
const systemTopic = "__system__"

// BroadcastConversationsChanged 推一条「对话列表变了」，让各端重拉列表。
//
// 与 `claude.update` 同一条系统通道：这条事件跟「打开了哪条对话」无关，
// 没有会话连接的标签页也要收到（`/clear` 会把一条对话的 id 换掉，侧栏必须跟着变）。
//
// 收到就重拉一次的代价是 `GET /api/conversations` 要重扫全部转录，所以只在
// 「列表里真会多一行/少一行/换个顺序」的地方推：新建对话的首条消息、这一轮结束
// （标题与 live/state 此时才定稿）、重命名/置顶/归档/删除/分叉、自动化任务投递。
// 不要按 prompt 逐条推——每条消息都改 last_active，但为它让所有连接重扫一遍
// 全部转录，在 NAS 上随对话数量线性变贵，换来的只有排序抖动。
func (s *Server) BroadcastConversationsChanged() {
	if s.d.Hub == nil {
		return
	}
	s.d.Hub.Broadcast(systemTopic, WireEvent{Kind: "conversations.changed"})
}

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
