package manager

import "testing"

func TestNewUUIDAndValidation(t *testing.T) {
	id, err := newUUID()
	if err != nil {
		t.Fatal(err)
	}
	if !validUUID(id) {
		t.Fatalf("newUUID 生成的不是合法 UUID: %q", id)
	}
	if id[14] != '4' {
		t.Fatalf("UUID 版本位 = %c, want 4", id[14])
	}
	for _, bad := range []string{"", "not-a-uuid", "../../etc/passwd", "11111111-2222-3333-4444-55555555555"} {
		if validUUID(bad) {
			t.Fatalf("%q 不应通过校验", bad)
		}
	}
}
