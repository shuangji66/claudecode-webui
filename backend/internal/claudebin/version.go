package claudebin

import (
	"os"
	"regexp"
	"runtime"
	"strconv"
	"strings"
)

// versionRE 同时充当「版本号合法」与「目录名安全」的校验：只允许数字、点和
// 可选的预发布后缀，天然排除 `../`、`/` 等路径穿越写法。
var versionRE = regexp.MustCompile(`^(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?$`)

func validVersion(v string) bool { return versionRE.MatchString(v) }

// Compare 按语义化版本比较 a 与 b：a 新返回 1，相同返回 0，a 旧返回 -1。
//
// 无法解析的版本号一律视为最小，保证不会因为一个脏目录名把排序搞崩。
func Compare(a, b string) int {
	am, ap := parseVersion(a)
	bm, bp := parseVersion(b)
	for i := range 3 {
		if am[i] != bm[i] {
			if am[i] > bm[i] {
				return 1
			}
			return -1
		}
	}
	switch {
	case ap == bp:
		return 0
	case ap == "":
		return 1 // 正式版高于预发布
	case bp == "":
		return -1
	case ap > bp:
		return 1
	default:
		return -1
	}
}

func parseVersion(v string) ([3]int, string) {
	var core [3]int
	m := versionRE.FindStringSubmatch(v)
	if m == nil {
		return core, ""
	}
	for i := range 3 {
		core[i], _ = strconv.Atoi(m[i+1])
	}
	return core, strings.TrimPrefix(m[4], "-")
}

// Platform 返回 npm 平台包的后缀，例如 linux-x64、linux-arm64-musl。
//
// claude 只在 Linux 服务器上跑，其它平台返回空串（安装时明确报错，而不是
// 猜一个包名让它 404）。
func Platform() string {
	if runtime.GOOS != "linux" {
		return ""
	}
	var arch string
	switch runtime.GOARCH {
	case "amd64":
		arch = "x64"
	case "arm64":
		arch = "arm64"
	default:
		return ""
	}
	if isMusl() {
		arch += "-musl"
	}
	return "linux-" + arch
}

// isMusl 通过动态链接器判断是否 Alpine 这类 musl 发行版。
// 选错包会得到 "not found" 或直接段错误，很难和"没装 glibc"联系起来。
func isMusl() bool {
	for _, p := range []string{
		"/lib/ld-musl-x86_64.so.1",
		"/lib/ld-musl-aarch64.so.1",
		"/lib64/ld-musl-x86_64.so.1",
		"/lib64/ld-musl-aarch64.so.1",
	} {
		if _, err := os.Stat(p); err == nil {
			return true
		}
	}
	return false
}
