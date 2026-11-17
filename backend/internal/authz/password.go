package authz

import (
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"
)

// 访问密码的基础复杂度与摘要参数。
//
// 落盘只保存带随机盐的 PBKDF2-SHA256 摘要（绝不存明文）：settings.json 的权限虽然是
// 0600，但备份、同步、截图都可能把它带走；摘要即使泄漏也不能直接当密码用来登录。
const (
	// MinPasswordLen / MaxPasswordLen 是密码长度边界（按 rune 计）。
	MinPasswordLen = 8
	MaxPasswordLen = 128
	// pbkdf2Iterations 与 pbkdf2KeyLen 是摘要参数。迭代次数调高只会让登录更慢，
	// 也让离线爆破更贵；校验一个密码约几十毫秒，只发生在登录那一次。
	pbkdf2Iterations = 210_000
	pbkdf2KeyLen     = 32
	passwordScheme   = "pbkdf2-sha256"
)

// ValidatePassword 校验访问密码的基础复杂度。
//
// 规则刻意保持"基础"：至少 8 位、同时包含字母与数字、不含控制字符。
// 不强制标点：这个面板跑在内网，规则太苛刻只会把人逼去记便签。
func ValidatePassword(pwd string) error {
	n := utf8.RuneCountInString(pwd)
	if n < MinPasswordLen {
		return fmt.Errorf("密码至少 %d 位", MinPasswordLen)
	}
	if n > MaxPasswordLen {
		return fmt.Errorf("密码最长 %d 位", MaxPasswordLen)
	}
	var letter, digit bool
	for _, r := range pwd {
		if unicode.IsControl(r) {
			return errors.New("密码不能包含控制字符")
		}
		if unicode.IsLetter(r) {
			letter = true
		}
		if unicode.IsDigit(r) {
			digit = true
		}
	}
	if !letter {
		return errors.New("密码需要包含字母")
	}
	if !digit {
		return errors.New("密码需要包含数字")
	}
	return nil
}

// HashPassword 生成带随机盐的密码摘要，格式：
//
//	pbkdf2-sha256$<迭代次数>$<salt base64>$<key base64>
//
// 盐每次随机生成：同一密码两次 Hash 的结果不同，避免"相同密码一眼看出"。
func HashPassword(pwd string) (string, error) {
	if err := ValidatePassword(pwd); err != nil {
		return "", err
	}
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return "", fmt.Errorf("authz: 生成密码盐: %w", err)
	}
	key, err := pbkdf2.Key(sha256.New, pwd, salt, pbkdf2Iterations, pbkdf2KeyLen)
	if err != nil {
		return "", fmt.Errorf("authz: 计算密码摘要: %w", err)
	}
	enc := base64.StdEncoding
	return strings.Join([]string{
		passwordScheme,
		strconv.Itoa(pbkdf2Iterations),
		enc.EncodeToString(salt),
		enc.EncodeToString(key),
	}, "$"), nil
}

// VerifyPassword 判断明文密码与存储摘要是否匹配。
//
// 摘要格式不认识、参数越界都按"不匹配"处理：坏配置不能被当成"无密码"放行。
func VerifyPassword(stored, pwd string) bool {
	parts := strings.Split(stored, "$")
	if len(parts) != 4 || parts[0] != passwordScheme {
		return false
	}
	iter, err := strconv.Atoi(parts[1])
	if err != nil || iter < 1 || iter > 10_000_000 {
		return false
	}
	enc := base64.StdEncoding
	salt, err := enc.DecodeString(parts[2])
	if err != nil || len(salt) == 0 {
		return false
	}
	want, err := enc.DecodeString(parts[3])
	if err != nil || len(want) == 0 {
		return false
	}
	got, err := pbkdf2.Key(sha256.New, pwd, salt, iter, len(want))
	if err != nil {
		return false
	}
	return subtle.ConstantTimeCompare(got, want) == 1
}
