package envpath

import "testing"

func TestEffective(t *testing.T) {
	t.Setenv("PATH", "/custom/bin")
	if got := Effective(); got != "/custom/bin" {
		t.Fatalf("Effective = %q", got)
	}
	t.Setenv("PATH", "   ")
	if got := Effective(); got != Default {
		t.Fatalf("空白 PATH 应回落到默认值，得到 %q", got)
	}
}

func TestApply(t *testing.T) {
	t.Setenv("PATH", "")
	if !Apply() {
		t.Fatal("空 PATH 时应打补丁")
	}
	if got := Effective(); got != Default {
		t.Fatalf("补丁后 PATH = %q", got)
	}
	if Apply() {
		t.Fatal("已有 PATH 时不应重复打补丁")
	}
}

func TestEnsure(t *testing.T) {
	t.Setenv("PATH", "/custom/bin")
	got := Ensure([]string{"HOME=/root"})
	if len(got) != 2 || got[1] != "PATH=/custom/bin" {
		t.Fatalf("Ensure = %v", got)
	}
	// 已有非空 PATH 时不动它
	got = Ensure([]string{"PATH=/keep/me"})
	if len(got) != 1 || got[0] != "PATH=/keep/me" {
		t.Fatalf("Ensure 不应覆盖已有 PATH: %v", got)
	}
	// 空值 PATH= 要当成缺失
	got = Ensure([]string{"PATH="})
	if len(got) != 2 || got[1] != "PATH=/custom/bin" {
		t.Fatalf("空 PATH= 应被补上: %v", got)
	}
}
