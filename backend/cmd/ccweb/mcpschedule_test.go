package main

import (
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"
)

// 调一次工具，返回文本结果与是否 isError。
func callScheduleMCP(t *testing.T, name string, args any) (string, bool) {
	t.Helper()
	raw, err := json.Marshal(args)
	if err != nil {
		t.Fatalf("编参数: %v", err)
	}
	params, err := json.Marshal(map[string]any{"name": name, "arguments": json.RawMessage(raw)})
	if err != nil {
		t.Fatalf("编 params: %v", err)
	}
	resp, ok := handleScheduleRPC(rpcRequest{ID: json.RawMessage(`1`), Method: "tools/call", Params: params})
	if !ok {
		t.Fatalf("%s 没有回包", name)
	}
	content, ok := resp.Result.(toolContent)
	if !ok {
		t.Fatalf("%s 的返回类型不是 toolContent: %#v", name, resp.Result)
	}
	if len(content.Content) == 0 {
		t.Fatalf("%s 没有内容", name)
	}
	text, _ := content.Content[0]["text"].(string)
	return text, content.IsError
}

func TestMCPScheduleCreateListEdit(t *testing.T) {
	t.Setenv("CCWEB_SCHEDULES_FILE", filepath.Join(t.TempDir(), "schedules.json"))

	text, isErr := callScheduleMCP(t, "schedule_create", map[string]any{
		"name":   "每日巡检",
		"prompt": "跑一遍测试并把失败列出来",
		"rule":   map[string]any{"kind": "daily", "time": "09:00", "timezone": "Asia/Shanghai"},
	})
	if isErr {
		t.Fatalf("创建失败: %s", text)
	}
	if !strings.Contains(text, "已创建自动化任务") || !strings.Contains(text, "每天 09:00") {
		t.Fatalf("创建回包不像话: %s", text)
	}
	// id 从回包里抠出来（"id <8 位十六进制>"）。
	id := ""
	if i := strings.Index(text, "id "); i >= 0 {
		rest := text[i+3:]
		if j := strings.IndexAny(rest, "）。"); j > 0 {
			id = rest[:j]
		}
	}
	if id == "" {
		t.Fatalf("回包里没有任务 id: %s", text)
	}

	list, isErr := callScheduleMCP(t, "schedule_list", map[string]any{})
	if isErr {
		t.Fatalf("列表失败: %s", list)
	}
	if !strings.Contains(list, "每日巡检") || !strings.Contains(list, "已开启") {
		t.Fatalf("列表内容不对: %s", list)
	}

	// 暂停 → 列表里状态变「已暂停」。
	if text, isErr := callScheduleMCP(t, "schedule_edit", map[string]any{"id": id, "action": "pause"}); isErr {
		t.Fatalf("暂停失败: %s", text)
	}
	list, _ = callScheduleMCP(t, "schedule_list", map[string]any{})
	if !strings.Contains(list, "已暂停") {
		t.Fatalf("暂停后列表没变: %s", list)
	}

	// 暂停中的任务改规则只换规则，不偷偷恢复（与 DSH 一致）；恢复要显式 resume。
	if text, isErr := callScheduleMCP(t, "schedule_edit", map[string]any{
		"id":   id,
		"rule": map[string]any{"kind": "hours", "interval": 2},
	}); isErr {
		t.Fatalf("改规则失败: %s", text)
	}
	list, _ = callScheduleMCP(t, "schedule_list", map[string]any{})
	if !strings.Contains(list, "已暂停") || !strings.Contains(list, "每 2 小时") {
		t.Fatalf("改规则后状态不对: %s", list)
	}
	if text, isErr := callScheduleMCP(t, "schedule_edit", map[string]any{"id": id, "action": "resume"}); isErr {
		t.Fatalf("恢复失败: %s", text)
	}
	list, _ = callScheduleMCP(t, "schedule_list", map[string]any{})
	if !strings.Contains(list, "已开启") {
		t.Fatalf("恢复后状态不对: %s", list)
	}

	if text, isErr := callScheduleMCP(t, "schedule_edit", map[string]any{"id": id, "action": "delete"}); isErr {
		t.Fatalf("删除失败: %s", text)
	}
	if list, _ := callScheduleMCP(t, "schedule_list", map[string]any{}); !strings.Contains(list, "没有任何自动化任务") {
		t.Fatalf("删除后列表还非空: %s", list)
	}
}

func TestMCPScheduleRejectsBadRule(t *testing.T) {
	t.Setenv("CCWEB_SCHEDULES_FILE", filepath.Join(t.TempDir(), "schedules.json"))
	cases := []struct {
		name string
		args map[string]any
		want string
	}{
		{
			name: "仅一次的时间在过去",
			args: map[string]any{
				"name": "过去", "prompt": "x",
				"rule": map[string]any{"kind": "once", "at": "2020-01-01T09:00:00+08:00"},
			},
			want: "没有下一次发生时间",
		},
		{
			name: "名称为空",
			args: map[string]any{"name": " ", "prompt": "x", "rule": map[string]any{"kind": "daily", "time": "09:00"}},
			want: "不能为空",
		},
		{
			name: "cron 字段数不对",
			args: map[string]any{"name": "c", "prompt": "x", "rule": map[string]any{"kind": "cron", "cron": "* * * *"}},
			want: "5 个字段",
		},
		{
			name: "修改不存在的任务",
			args: map[string]any{"id": "nope", "action": "pause"},
			want: "",
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			tool := "schedule_create"
			if _, has := c.args["id"]; has {
				tool = "schedule_edit"
			}
			text, isErr := callScheduleMCP(t, tool, c.args)
			if !isErr {
				t.Fatalf("应当报错，得到: %s", text)
			}
			if c.want != "" && !strings.Contains(text, c.want) {
				t.Fatalf("错误文案 = %q, want 含 %q", text, c.want)
			}
		})
	}
}

// tools/list 必须把三个工具都摆出来，且 rule 是必填。
func TestMCPScheduleToolDefs(t *testing.T) {
	resp, ok := handleScheduleRPC(rpcRequest{ID: json.RawMessage(`1`), Method: "tools/list"})
	if !ok {
		t.Fatal("tools/list 没有回包")
	}
	result, _ := resp.Result.(map[string]any)
	tools, _ := result["tools"].([]map[string]any)
	if len(tools) != 3 {
		t.Fatalf("工具数 = %d, want 3", len(tools))
	}
	names := map[string]bool{}
	for _, tool := range tools {
		name, _ := tool["name"].(string)
		names[name] = true
	}
	for _, want := range []string{"schedule_create", "schedule_list", "schedule_edit"} {
		if !names[want] {
			t.Fatalf("缺少工具 %s", want)
		}
	}
}
