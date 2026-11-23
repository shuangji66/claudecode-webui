package gateway

import "testing"

// 根目录 `/` 是唯一以分隔符结尾的路径：给两边都拼一个分隔符再比前缀（旧写法）时，
// `path = "/"` 变成 `"//"`，永远匹配不上任何受保护目录，于是一路放行——撤销根目录
// 等于把应用自己、数据目录、claude HOME 的授权一起撤掉，而且界面再无入口恢复。
func TestProtectedConflictIncludesRootAndAncestors(t *testing.T) {
	s := &Server{d: Deps{DirsProtected: []string{"/vol1/@appdata/x/data"}}}
	cases := map[string]string{
		"/":                         "相等/祖先：根目录是任何绝对路径的祖先",
		"/vol1":                     "祖先目录",
		"/vol1/@appdata":            "祖先目录",
		"/vol1/@appdata/x/data":     "相等",
		"/vol1/@appdata/x/data/sub": "子路径",
	}
	for p, why := range cases {
		if guard, blocked := s.protectedConflict(p); !blocked {
			t.Errorf("%s（%q）应被拒绝，实际放行", why, p)
		} else if guard == "" {
			t.Errorf("%q 被拒绝但没给出命中的 guard", p)
		}
	}
	// 无关目录照旧可撤销。
	if _, blocked := s.protectedConflict("/vol1/@appshare"); blocked {
		t.Error("/vol1/@appshare 与受保护目录无关，不该被拒绝")
	}
}
