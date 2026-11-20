// Package hub 是会话事件的订阅与广播中心。
//
// 一条 claude 会话可能同时被多个浏览器标签观察，因此按 topic（= session id）
// 维护订阅者集合，事件广播给该 topic 下的所有连接。
//
// 并发约束：Broadcast 持有读锁遍历订阅者，Send 由实现方保证不阻塞过久
// （网关侧写帧带超时，超时即退订）。
package hub

import "sync"

// Client 是可接收事件的连接。
type Client interface {
	// SendJSON 序列化并发送一条事件；返回错误表示连接已不可用。
	SendJSON(v any) error
}

// Hub 维护 topic → 订阅者集合。
type Hub struct {
	mu   sync.RWMutex
	subs map[string]map[Client]struct{}
}

// New 构造 Hub。
func New() *Hub {
	return &Hub{subs: make(map[string]map[Client]struct{})}
}

// Subscribe 把 c 订阅到 topic。
func (h *Hub) Subscribe(topic string, c Client) {
	if topic == "" || c == nil {
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	set, ok := h.subs[topic]
	if !ok {
		set = make(map[Client]struct{})
		h.subs[topic] = set
	}
	set[c] = struct{}{}
}

// Unsubscribe 取消订阅；集合空时删除 topic。
func (h *Hub) Unsubscribe(topic string, c Client) {
	h.mu.Lock()
	defer h.mu.Unlock()
	set, ok := h.subs[topic]
	if !ok {
		return
	}
	delete(set, c)
	if len(set) == 0 {
		delete(h.subs, topic)
	}
}

// Broadcast 向 topic 下所有订阅者发送 v，返回发送失败的订阅者数量。
// 失败的订阅者会被自动移除，避免死连接长期占位。
func (h *Hub) Broadcast(topic string, v any) int {
	h.mu.RLock()
	set := h.subs[topic]
	targets := make([]Client, 0, len(set))
	for c := range set {
		targets = append(targets, c)
	}
	h.mu.RUnlock()

	var failed []Client
	for _, c := range targets {
		if err := c.SendJSON(v); err != nil {
			failed = append(failed, c)
		}
	}
	if len(failed) > 0 {
		h.mu.Lock()
		for _, c := range failed {
			if set, ok := h.subs[topic]; ok {
				delete(set, c)
				if len(set) == 0 {
					delete(h.subs, topic)
				}
			}
		}
		h.mu.Unlock()
	}
	return len(failed)
}

// Count 返回 topic 下的订阅者数量。
func (h *Hub) Count(topic string) int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.subs[topic])
}

// Retopical 是可接收「你的 topic 变了」的连接（可选）。
//
// Rekey 搬完订阅要顺手告诉连接新 topic，否则连接断开时仍然用**旧** topic 去
// Unsubscribe：旧集合里已经没有它（搬走了），新集合里那条却永远留着——一条死连接
// 之后每次广播都要失败一次才被摘掉。
type Retopical interface {
	Retopic(topic string)
}

// Rekey 把 topic 下的所有订阅者搬到另一个 topic（`/clear` 之后 CLI 换了会话 id）。
//
// **不搬的话，已经连着的页面从此收不到任何事件**：订阅是在握手时按当时的会话 id
// 建立的，而事件现在按新 id 广播——用户发消息后界面上什么都不动，直到他刷新页面。
// 进程没变、连接也没断，只是这条对话的 id 换了，所以订阅要跟着搬而不是重连。
//
// 目标 topic 上已有的订阅者保留（那是别的连接，两边合并即可）。
func (h *Hub) Rekey(oldTopic, newTopic string) {
	if oldTopic == "" || newTopic == "" || oldTopic == newTopic {
		return
	}
	h.mu.Lock()
	from, ok := h.subs[oldTopic]
	if !ok {
		h.mu.Unlock()
		return
	}
	to := h.subs[newTopic]
	if to == nil {
		to = make(map[Client]struct{}, len(from))
		h.subs[newTopic] = to
	}
	moved := make([]Client, 0, len(from))
	for c := range from {
		to[c] = struct{}{}
		moved = append(moved, c)
	}
	delete(h.subs, oldTopic)
	h.mu.Unlock()

	// 在锁外回调：Retopic 是客户端自己的锁，与 Hub 的锁无关，嵌套持有可能在
	// 另一边（Unsubscribe 里取 Hub 锁）形成环。
	for _, c := range moved {
		if r, ok := c.(Retopical); ok {
			r.Retopic(newTopic)
		}
	}
}

// Topics 返回当前有订阅者的 topic 快照。
func (h *Hub) Topics() []string {
	h.mu.RLock()
	defer h.mu.RUnlock()
	out := make([]string, 0, len(h.subs))
	for t := range h.subs {
		out = append(out, t)
	}
	return out
}
