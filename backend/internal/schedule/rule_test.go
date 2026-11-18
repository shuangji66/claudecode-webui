package schedule

import (
	"testing"
	"time"
)

func mustLoc(t *testing.T, name string) *time.Location {
	t.Helper()
	loc, err := time.LoadLocation(name)
	if err != nil {
		t.Fatalf("加载时区 %s: %v", name, err)
	}
	return loc
}

func at(t *testing.T, s string) time.Time {
	t.Helper()
	v, err := time.Parse(time.RFC3339, s)
	if err != nil {
		t.Fatalf("解析时间 %s: %v", s, err)
	}
	return v
}

func TestRuleNext(t *testing.T) {
	sh := mustLoc(t, "Asia/Shanghai")
	cases := []struct {
		name  string
		rule  Rule
		after string
		want  string
		ok    bool
	}{
		{
			name:  "仅一次：未来时间原样返回",
			rule:  Rule{Kind: KindOnce, At: "2026-11-19T09:00:00+08:00"},
			after: "2026-11-18T12:00:00+08:00",
			want:  "2026-11-19T09:00:00+08:00",
			ok:    true,
		},
		{
			name:  "仅一次：已经过去就没有下一次",
			rule:  Rule{Kind: KindOnce, At: "2026-11-18T09:00:00+08:00"},
			after: "2026-11-18T12:00:00+08:00",
			ok:    false,
		},
		{
			name:  "每 15 分钟",
			rule:  Rule{Kind: KindMinutes, Interval: 15},
			after: "2026-11-18T12:00:00+08:00",
			want:  "2026-11-18T12:15:00+08:00",
			ok:    true,
		},
		{
			name:  "每 2 小时",
			rule:  Rule{Kind: KindHours, Interval: 2},
			after: "2026-11-18T12:00:00+08:00",
			want:  "2026-11-18T14:00:00+08:00",
			ok:    true,
		},
		{
			name:  "每天：还没到点就是今天",
			rule:  Rule{Kind: KindDaily, Time: "09:00", Timezone: sh.String()},
			after: "2026-11-18T08:00:00+08:00",
			want:  "2026-11-18T09:00:00+08:00",
			ok:    true,
		},
		{
			name:  "每天：过点就顺延到明天",
			rule:  Rule{Kind: KindDaily, Time: "09:00", Timezone: sh.String()},
			after: "2026-11-18T09:30:00+08:00",
			want:  "2026-11-19T09:00:00+08:00",
			ok:    true,
		},
		{
			name:  "工作日：周五过点跳到周一",
			rule:  Rule{Kind: KindWeekdays, Time: "09:00", Timezone: sh.String()},
			after: "2026-11-20T09:30:00+08:00", // 周五
			want:  "2026-11-23T09:00:00+08:00", // 周一
			ok:    true,
		},
		{
			name:  "每周：只选周三",
			rule:  Rule{Kind: KindWeekly, Time: "09:00", Weekdays: []int{3}, Timezone: sh.String()},
			after: "2026-11-18T10:00:00+08:00", // 周三过点
			want:  "2026-11-25T09:00:00+08:00",
			ok:    true,
		},
		{
			name:  "每月 31 日：二月落在月末",
			rule:  Rule{Kind: KindMonthly, Day: 31, Time: "08:00", Timezone: sh.String()},
			after: "2026-02-01T00:00:00+08:00",
			want:  "2026-02-28T08:00:00+08:00",
			ok:    true,
		},
		{
			name:  "cron：每 15 分钟",
			rule:  Rule{Kind: KindCron, Cron: "*/15 * * * *", Timezone: sh.String()},
			after: "2026-11-18T10:07:00+08:00",
			want:  "2026-11-18T10:15:00+08:00",
			ok:    true,
		},
		{
			name:  "cron：工作日 09:30",
			rule:  Rule{Kind: KindCron, Cron: "30 9 * * 1-5", Timezone: sh.String()},
			after: "2026-11-20T10:00:00+08:00", // 周五
			want:  "2026-11-23T09:30:00+08:00", // 周一
			ok:    true,
		},
		{
			name:  "cron：每月 1 日 0 点",
			rule:  Rule{Kind: KindCron, Cron: "0 0 1 * *", Timezone: sh.String()},
			after: "2026-11-18T00:00:00+08:00",
			want:  "2026-12-01T00:00:00+08:00",
			ok:    true,
		},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, ok := c.rule.Next(at(t, c.after))
			if ok != c.ok {
				t.Fatalf("ok = %v, want %v（got %v）", ok, c.ok, got)
			}
			if !ok {
				return
			}
			if want := at(t, c.want); !got.Equal(want) {
				t.Fatalf("next = %v, want %v", got.Format(time.RFC3339), want.Format(time.RFC3339))
			}
		})
	}
}

func TestRuleValidate(t *testing.T) {
	bad := []Rule{
		{Kind: "nope"},
		{Kind: KindOnce, At: "2026-11-19 09:00"},
		{Kind: KindMinutes, Interval: 0},
		{Kind: KindHours},
		{Kind: KindDaily, Time: "9点"},
		{Kind: KindDaily, Time: "24:00"},
		{Kind: KindWeekly, Time: "09:00"},
		{Kind: KindWeekly, Time: "09:00", Weekdays: []int{7}},
		{Kind: KindMonthly, Time: "09:00", Day: 0},
		{Kind: KindMonthly, Time: "09:00", Day: 32},
		{Kind: KindCron, Cron: "* * * *"},
		{Kind: KindCron, Cron: "*/0 * * * *"},
		{Kind: KindCron, Cron: "61 * * * *"},
		{Kind: KindDaily, Time: "09:00", Timezone: "Mars/Olympus"},
	}
	for _, r := range bad {
		if err := r.Validate(); err == nil {
			t.Fatalf("规则 %+v 应当校验失败", r)
		}
	}
	good := []Rule{
		{Kind: KindOnce, At: "2026-11-19T09:00:00+08:00"},
		{Kind: KindMinutes, Interval: 5},
		{Kind: KindHours, Interval: 3},
		{Kind: KindDaily, Time: "09:00"},
		{Kind: KindWeekdays, Time: "09:00"},
		{Kind: KindWeekly, Time: "09:00", Weekdays: []int{1, 3, 5}},
		{Kind: KindMonthly, Time: "09:00", Day: 15},
		{Kind: KindCron, Cron: "0 9 * * 1-5"},
		{Kind: KindCron, Cron: "0,30 8-18 * * *"},
	}
	for _, r := range good {
		if err := r.Validate(); err != nil {
			t.Fatalf("规则 %+v 应当通过: %v", r, err)
		}
	}
}

// 周与日同时受限时按标准 cron 取「或」：`0 9 1 * 1` 在 1 号或周一都触发。
func TestCronDomDowOr(t *testing.T) {
	sh := mustLoc(t, "Asia/Shanghai")
	rule := Rule{Kind: KindCron, Cron: "0 9 1 * 1", Timezone: sh.String()}
	// 2026-11-18 是周三；下一次应当是 11-23（周一），而不是 12-01。
	got, ok := rule.Next(at(t, "2026-11-18T10:00:00+08:00"))
	if !ok {
		t.Fatal("预期有下一次")
	}
	if want := at(t, "2026-11-23T09:00:00+08:00"); !got.Equal(want) {
		t.Fatalf("next = %v, want %v", got.Format(time.RFC3339), want.Format(time.RFC3339))
	}
}
