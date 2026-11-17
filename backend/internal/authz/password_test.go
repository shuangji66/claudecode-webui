package authz

import (
	"strings"
	"testing"
)

func TestValidatePassword(t *testing.T) {
	cases := []struct {
		name string
		pwd  string
		ok   bool
	}{
		{"足够强", "s3cret-123", true},
		{"纯中文含数字", "密码abc12345", true},
		{"太短", "ab12", false},
		{"只有字母", "abcdefghij", false},
		{"只有数字", "1234567890", false},
		{"控制字符", "abc12345\n", false},
		{"超长", strings.Repeat("a1", 70), false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := ValidatePassword(tc.pwd)
			if tc.ok && err != nil {
				t.Fatalf("应当通过，实际 %v", err)
			}
			if !tc.ok && err == nil {
				t.Fatal("应当被拒绝")
			}
		})
	}
}

func TestHashPasswordRoundTrip(t *testing.T) {
	pwd := "s3cret-123"
	hash, err := HashPassword(pwd)
	if err != nil {
		t.Fatalf("HashPassword: %v", err)
	}
	if strings.Contains(hash, pwd) {
		t.Fatalf("摘要里不能出现明文: %s", hash)
	}
	if !strings.HasPrefix(hash, passwordScheme+"$") {
		t.Fatalf("摘要格式不对: %s", hash)
	}
	if !VerifyPassword(hash, pwd) {
		t.Fatal("正确密码应校验通过")
	}
	if VerifyPassword(hash, pwd+"x") {
		t.Fatal("错误密码不应通过")
	}
}

func TestHashPasswordUsesRandomSalt(t *testing.T) {
	a, err := HashPassword("s3cret-123")
	if err != nil {
		t.Fatal(err)
	}
	b, err := HashPassword("s3cret-123")
	if err != nil {
		t.Fatal(err)
	}
	if a == b {
		t.Fatal("同一密码两次摘要不应相同（盐必须随机）")
	}
}

func TestVerifyPasswordRejectsMalformed(t *testing.T) {
	for _, stored := range []string{
		"",
		"plain-text",
		"pbkdf2-sha256$210000$not-base64$also-bad",
		"pbkdf2-sha256$0$AAAA$AAAA",
		"bcrypt$210000$AAAA$AAAA",
	} {
		if VerifyPassword(stored, "s3cret-123") {
			t.Fatalf("坏摘要 %q 不应通过", stored)
		}
	}
}

func TestHashPasswordRejectsWeak(t *testing.T) {
	if _, err := HashPassword("short"); err == nil {
		t.Fatal("弱密码不应被哈希（写入前必须先过复杂度校验）")
	}
}
