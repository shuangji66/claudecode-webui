package claudebin

import (
	"runtime"
	"testing"
)

func TestCompare(t *testing.T) {
	cases := []struct {
		a, b string
		want int
	}{
		{"2.1.325", "2.1.311", 1},
		{"2.1.311", "2.1.325", -1},
		{"2.1.311", "2.1.311", 0},
		{"2.10.0", "2.9.9", 1},
		{"2.1.325", "2.1.325-beta.1", 1},
		{"2.1.325-beta.1", "2.1.325", -1},
		{"garbage", "2.1.0", -1},
	}
	for _, c := range cases {
		if got := Compare(c.a, c.b); got != c.want {
			t.Fatalf("Compare(%q,%q)=%d, want %d", c.a, c.b, got, c.want)
		}
	}
}

func TestValidVersionRejectsPathTraversal(t *testing.T) {
	ok := []string{"2.1.325", "1.0.0", "2.1.325-beta.1"}
	bad := []string{"", "..", "../2.1.325", "2.1.325/../../etc", "2.1", "v2.1.325", "2.1.325 "}
	for _, v := range ok {
		if !validVersion(v) {
			t.Fatalf("%q 应被接受", v)
		}
	}
	for _, v := range bad {
		if validVersion(v) {
			t.Fatalf("%q 应被拒绝", v)
		}
	}
}

func TestPlatform(t *testing.T) {
	got := Platform()
	if runtime.GOOS != "linux" || runtime.GOARCH != "amd64" {
		t.Skipf("当前平台 %s/%s 不适用", runtime.GOOS, runtime.GOARCH)
	}
	if got != "linux-x64" && got != "linux-x64-musl" {
		t.Fatalf("Platform()=%q，期望 linux-x64 或 linux-x64-musl", got)
	}
}
