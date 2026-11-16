package wsframe

import (
	"bytes"
	"errors"
	"strings"
	"testing"
)

func TestAcceptKey(t *testing.T) {
	// RFC 6455 §1.3 的官方示例
	got := AcceptKey("dGhlIHNhbXBsZSBub25jZQ==")
	want := "s3pPLMBiTxaQ9kYGzzhZRbK+xOo="
	if got != want {
		t.Fatalf("AcceptKey = %q, want %q", got, want)
	}
}

func TestEncodeDecodeRoundTrip(t *testing.T) {
	cases := []struct {
		name    string
		op      byte
		payload []byte
	}{
		{"empty", OpText, nil},
		{"small", OpText, []byte(`{"kind":"prompt"}`)},
		{"126-boundary", OpText, bytes.Repeat([]byte("a"), 126)},
		{"large", OpText, bytes.Repeat([]byte("b"), 70000)},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			raw := Encode(tc.op, tc.payload)
			f, err := ReadFrame(bytes.NewReader(raw), DefaultMaxMessageBytes)
			if err != nil {
				t.Fatalf("ReadFrame: %v", err)
			}
			if f.Op != tc.op {
				t.Fatalf("op = %d, want %d", f.Op, tc.op)
			}
			if !f.Fin {
				t.Fatal("Fin 应为 true")
			}
			if !bytes.Equal(f.Payload, tc.payload) {
				t.Fatalf("payload 长度 %d != %d", len(f.Payload), len(tc.payload))
			}
		})
	}
}

func TestReadMaskedFrame(t *testing.T) {
	payload := []byte(`{"kind":"interrupt"}`)
	mask := [4]byte{0x11, 0x22, 0x33, 0x44}
	raw := EncodeMasked(OpText, payload, mask)
	f, err := ReadFrame(bytes.NewReader(raw), DefaultMaxMessageBytes)
	if err != nil {
		t.Fatalf("ReadFrame: %v", err)
	}
	if !bytes.Equal(f.Payload, payload) {
		t.Fatalf("解掩码后 = %q, want %q", f.Payload, payload)
	}
}

func TestReadFrameTooLarge(t *testing.T) {
	raw := Encode(OpText, bytes.Repeat([]byte("x"), 2048))
	_, err := ReadFrame(bytes.NewReader(raw), 1024)
	if err == nil {
		t.Fatal("期望超限错误")
	}
	if !errors.Is(err, ErrTooLarge) {
		t.Fatalf("err = %v, 期望 ErrTooLarge", err)
	}
}

func TestControlFrameTooLarge(t *testing.T) {
	// 控制帧载荷上限 125 字节
	raw := Encode(OpPing, bytes.Repeat([]byte("y"), 200))
	if _, err := ReadFrame(bytes.NewReader(raw), DefaultMaxMessageBytes); err == nil {
		t.Fatal("期望控制帧超限错误")
	}
}

// TestReadMessageFragmented 手工拼一个两片的消息，验证聚合。
func TestReadMessageFragmented(t *testing.T) {
	first := Encode(OpText, []byte("hello "))
	first[0] &^= 0x80 // 清 FIN
	second := Encode(OpContinuation, []byte("world"))

	raw := append(append([]byte{}, first...), second...)
	op, payload, err := ReadMessage(bytes.NewReader(raw), DefaultMaxMessageBytes)
	if err != nil {
		t.Fatalf("ReadMessage: %v", err)
	}
	if op != OpText {
		t.Fatalf("op = %d, want %d", op, OpText)
	}
	if string(payload) != "hello world" {
		t.Fatalf("payload = %q", payload)
	}
}

func TestEncodeClose(t *testing.T) {
	raw := EncodeClose(1000)
	f, err := ReadFrame(bytes.NewReader(raw), 1024)
	if err != nil {
		t.Fatalf("ReadFrame: %v", err)
	}
	if f.Op != OpClose {
		t.Fatalf("op = %d, want OpClose", f.Op)
	}
	if len(f.Payload) != 2 {
		t.Fatalf("close 载荷长度 = %d, want 2", len(f.Payload))
	}
}

func TestEncodeNoMaskBit(t *testing.T) {
	raw := Encode(OpText, []byte("x"))
	if raw[1]&0x80 != 0 {
		t.Fatal("服务端帧不应置 mask 位")
	}
	if !strings.HasPrefix(string(raw), "\x81") {
		t.Fatalf("首字节 = %x, want 81", raw[0])
	}
}

// 回归：分片聚合的剩余预算为 0 时不能退回默认上限。
//
// ReadFrame 把 maxPayload<=0 当成「未指定」并重置为 DefaultMaxMessageBytes，
// 于是首片刚好用满预算后，续片可以先分配 16MB 再被拒（终端 1MB 上限形同虚设）。
func TestReadMessageFragmentBudgetExhausted(t *testing.T) {
	first := Encode(OpText, bytes.Repeat([]byte("a"), 8))
	first[0] &^= 0x80 // 清 FIN
	second := Encode(OpContinuation, []byte("tail"))
	raw := append(append([]byte{}, first...), second...)

	cr := bytes.NewReader(raw)
	if _, _, err := ReadMessage(cr, 8); !errors.Is(err, ErrTooLarge) {
		t.Fatalf("err = %v, want ErrTooLarge", err)
	}
	// 预算已经耗尽就不该再读下一片：旧实现会把剩余字节也消费掉（并先分配 16MB）。
	if cr.Len() == 0 {
		t.Fatal("预算耗尽后仍然读取了后续分片")
	}
}
