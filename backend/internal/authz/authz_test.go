package authz

import "testing"

func TestDisabledAllowsEverything(t *testing.T) {
	g := New("")
	if g.Required() {
		t.Fatal("空 token 不应要求鉴权")
	}
	if !g.Check("", "") {
		t.Fatal("未启用鉴权时应放行")
	}
}

func TestBearerHeader(t *testing.T) {
	g := New("s3cret")
	if !g.Required() {
		t.Fatal("应启用鉴权")
	}
	cases := []struct {
		name, header, query string
		want                bool
	}{
		{"正确 Bearer", "Bearer s3cret", "", true},
		{"大小写不敏感", "bearer s3cret", "", true},
		{"错误 token", "Bearer nope", "", false},
		{"缺少头", "", "", false},
		{"非 Bearer 方案", "Basic s3cret", "", false},
		{"query token", "", "s3cret", true},
		{"query 错误", "", "nope", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := g.Check(tc.header, tc.query); got != tc.want {
				t.Fatalf("Check(%q,%q) = %v, want %v", tc.header, tc.query, got, tc.want)
			}
		})
	}
}

func TestQueryTokenTakesPrecedence(t *testing.T) {
	g := New("right")
	// WS 场景：浏览器无法设置自定义头，只能靠 query。
	if !g.Check("Bearer wrong", "right") {
		t.Fatal("query token 正确时应放行")
	}
}
