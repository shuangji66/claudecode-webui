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
