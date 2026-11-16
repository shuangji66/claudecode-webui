// Package wsframe 实现服务端所需的最小 WebSocket（RFC 6455）帧编解码。
//
// 刻意不引入第三方库：本应用只需要「服务端接收客户端 JSON 文本帧、回写 JSON 文本帧、
// 处理 ping/pong/close」这一条路径，手写比拉依赖更可控，也与本项目其它模块的零依赖风格一致。
//
// 用法约定：
//   - 服务端写出的帧一律不分片、不掩码（Encode 负责）。
//   - 客户端发来的帧可能分片，用 ReadMessage 聚合。
package wsframe

import (
	"crypto/sha1"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
)

// WebSocket opcode（RFC 6455 §5.2）。
const (
	OpContinuation byte = 0x0
	OpText         byte = 0x1
	OpBinary       byte = 0x2
	OpClose        byte = 0x8
	OpPing         byte = 0x9
	OpPong         byte = 0xA
)

// acceptGUID 是握手用的固定魔术字符串（RFC 6455 §1.3）。
const acceptGUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

// DefaultMaxMessageBytes 是单条消息（聚合后）的上限。
// 除了命令 JSON，还要容纳图片/PDF 的 base64（前端总大小限制为 10MB），
// 因此设为 16MB；仍然能挡住「长度字段打爆内存」的入口。
const DefaultMaxMessageBytes = 16 << 20

// MaxControlPayload 是控制帧载荷上限（RFC 6455 规定 125 字节）。
const MaxControlPayload = 125

// ErrTooLarge 表示帧/消息超过配置上限。
var ErrTooLarge = errors.New("wsframe: message too large")

// AcceptKey 由客户端 Sec-WebSocket-Key 计算 Sec-WebSocket-Accept。
func AcceptKey(key string) string {
	h := sha1.New()
	io.WriteString(h, key)
	io.WriteString(h, acceptGUID)
	return base64.StdEncoding.EncodeToString(h.Sum(nil))
}

// Frame 是一个已解码的 WebSocket 帧。
type Frame struct {
	Op      byte
	Fin     bool
	Payload []byte
}

// ReadFrame 从 r 读取一个帧。masked 位必须由客户端置位（RFC 6455 §5.1），
// 但这里不做强制校验——测试与内部管道会发送未掩码帧。
func ReadFrame(r io.Reader, maxPayload int) (Frame, error) {
	if maxPayload <= 0 {
		maxPayload = DefaultMaxMessageBytes
	}
	var hdr [2]byte
	if _, err := io.ReadFull(r, hdr[:]); err != nil {
		return Frame{}, err
	}
	fin := hdr[0]&0x80 != 0
	op := hdr[0] & 0x0f
	masked := hdr[1]&0x80 != 0
	length := uint64(hdr[1] & 0x7f)

	switch length {
	case 126:
		var ext [2]byte
		if _, err := io.ReadFull(r, ext[:]); err != nil {
			return Frame{}, err
		}
		length = uint64(binary.BigEndian.Uint16(ext[:]))
	case 127:
		var ext [8]byte
		if _, err := io.ReadFull(r, ext[:]); err != nil {
			return Frame{}, err
		}
		length = binary.BigEndian.Uint64(ext[:])
	}

	// 先校验上限再分配：长度字段完全由对端控制。
	if length > uint64(maxPayload) {
		return Frame{}, fmt.Errorf("%w: %d bytes", ErrTooLarge, length)
	}
	if op >= OpClose && length > MaxControlPayload {
		return Frame{}, fmt.Errorf("wsframe: control frame too large: %d", length)
	}

	var mask [4]byte
	if masked {
		if _, err := io.ReadFull(r, mask[:]); err != nil {
			return Frame{}, err
		}
	}
	payload := make([]byte, length)
	if _, err := io.ReadFull(r, payload); err != nil {
		return Frame{}, err
	}
	if masked {
		for i := range payload {
			payload[i] ^= mask[i%4]
		}
	}
	return Frame{Op: op, Fin: fin, Payload: payload}, nil
}

// ReadMessage 读取一条完整消息（自动聚合分片），返回 opcode 与载荷。
// 控制帧（close/ping/pong）会原样返回，不参与聚合。
func ReadMessage(r io.Reader, maxBytes int) (op byte, payload []byte, err error) {
	if maxBytes <= 0 {
		maxBytes = DefaultMaxMessageBytes
	}
	f, err := ReadFrame(r, maxBytes)
	if err != nil {
		return 0, nil, err
	}
	if f.Op >= OpClose {
		return f.Op, f.Payload, nil
	}
	op = f.Op
	buf := append([]byte(nil), f.Payload...)
	for !f.Fin {
		// 剩余预算必须显式判：ReadFrame 把 <=0 当成「未指定」并重置为
		// DefaultMaxMessageBytes，预算耗尽时反而允许下一片先分配 16MB
		// （终端 1MB 上限会被放大成 16MB 分配）。
		remaining := maxBytes - len(buf)
		if remaining <= 0 {
			return 0, nil, ErrTooLarge
		}
		f, err = ReadFrame(r, remaining)
		if err != nil {
			return 0, nil, err
		}
		if f.Op != OpContinuation {
			return 0, nil, errors.New("wsframe: expected continuation frame")
		}
		buf = append(buf, f.Payload...)
		if len(buf) > maxBytes {
			return 0, nil, ErrTooLarge
		}
	}
	return op, buf, nil
}

// Encode 把一条消息编成单个未掩码的 FIN 帧（服务端 → 客户端）。
func Encode(op byte, payload []byte) []byte {
	return encode(op, payload, true)
}

// EncodeClose 编一个 close 帧，code 为 RFC 6455 状态码（0 表示不带 code）。
func EncodeClose(code uint16) []byte {
	if code == 0 {
		return encode(OpClose, nil, true)
	}
	buf := make([]byte, 2)
	binary.BigEndian.PutUint16(buf, code)
	return encode(OpClose, buf, true)
}

func encode(op byte, payload []byte, fin bool) []byte {
	n := len(payload)
	var head []byte
	b0 := op & 0x0f
	if fin {
		b0 |= 0x80
	}
	switch {
	case n < 126:
		head = []byte{b0, byte(n)}
	case n <= 0xffff:
		head = make([]byte, 4)
		head[0] = b0
		head[1] = 126
		binary.BigEndian.PutUint16(head[2:], uint16(n))
	default:
		head = make([]byte, 10)
		head[0] = b0
		head[1] = 127
		binary.BigEndian.PutUint64(head[2:], uint64(n))
	}
	out := make([]byte, 0, len(head)+n)
	out = append(out, head...)
	out = append(out, payload...)
	return out
}

// EncodeMasked 把消息编成掩码帧，仅用于测试（模拟浏览器）。
func EncodeMasked(op byte, payload []byte, mask [4]byte) []byte {
	raw := encode(op, payload, true)
	// encode 产生的 header 长度：2/4/10
	var hl int
	switch raw[1] & 0x7f {
	case 126:
		hl = 4
	case 127:
		hl = 10
	default:
		hl = 2
	}
	out := make([]byte, 0, len(raw)+4)
	out = append(out, raw[:hl]...)
	// 置 mask 位
	out[1] |= 0x80
	out = append(out, mask[:]...)
	for i, b := range raw[hl:] {
		out = append(out, b^mask[i%4])
	}
	return out
}
