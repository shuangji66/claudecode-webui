// 时间规则：只算「下一次什么时候」，不碰 I/O。
//
// 支持 7 种形态，覆盖 DSH 自动化任务里引导式那几档 + 5 字段 cron：
//
//	once      仅一次（At 为 RFC3339）
//	minutes   每 N 分钟
//	hours     每 N 小时
//	daily     每天 HH:MM
//	weekdays  周一至周五 HH:MM
//	weekly    每周若干天 HH:MM
//	monthly   每月 N 日 HH:MM（该月没有这一天就落在月末）
//	cron      5 字段：分 时 日 月 周
//
// 不引 RRULE 库是刻意的：完整 RRULE 语法要一个第三方依赖，而引导式 + cron 已经覆盖
// 实际会用的规则；DSH 的「自定义」里也把 cron 与 RRULE 并列支持。
package schedule

import (
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"
)

// 规则类型。
const (
	KindOnce     = "once"
	KindMinutes  = "minutes"
	KindHours    = "hours"
	KindDaily    = "daily"
	KindWeekdays = "weekdays"
	KindWeekly   = "weekly"
	KindMonthly  = "monthly"
	KindCron     = "cron"
)

// 任务的两种时间精度上限：重复任务每 N 分钟/小时时的最小间隔。
const (
	MinIntervalMinutes = 1
	MinIntervalHours   = 1
)

// Rule 是一条时间规则。字段组合由 Kind 决定。
type Rule struct {
	Kind string `json:"kind"`
	// Interval 是 minutes/hours 的间隔；其余类型固定为 1。
	Interval int `json:"interval,omitempty"`
	// Time 是 HH:MM，用于 daily/weekdays/weekly/monthly。
	Time string `json:"time,omitempty"`
	// Weekdays 是 weekly 的星期集合，0=周日 … 6=周六。
	Weekdays []int `json:"weekdays,omitempty"`
	// Day 是 monthly 的日期（1..31）。
	Day int `json:"day,omitempty"`
	// At 是 once 的绝对时间（RFC3339）。
	At string `json:"at,omitempty"`
	// Cron 是 5 字段表达式（分 时 日 月 周）。
	Cron string `json:"cron,omitempty"`
	// Timezone 是 IANA 时区名；空表示用服务器本地时区。
	Timezone string `json:"timezone,omitempty"`
}

var errNoOccurrence = errors.New("schedule: 这条规则没有下一次发生时间")

// Location 返回规则使用的时区；非法时区回落到本地时区（Validate 会先挡掉）。
func (r Rule) Location() *time.Location {
	if r.Timezone == "" {
		return time.Local
	}
	loc, err := time.LoadLocation(r.Timezone)
	if err != nil {
		return time.Local
	}
	return loc
}

// Validate 检查规则本身是否自洽。
func (r Rule) Validate() error {
	if r.Timezone != "" {
		if _, err := time.LoadLocation(r.Timezone); err != nil {
			return fmt.Errorf("schedule: 未知时区 %q", r.Timezone)
		}
	}
	switch r.Kind {
	case KindOnce:
		if _, err := time.Parse(time.RFC3339, r.At); err != nil {
			return fmt.Errorf("schedule: 仅一次任务需要 RFC3339 时间: %w", err)
		}
	case KindMinutes:
		if r.Interval < MinIntervalMinutes {
			return fmt.Errorf("schedule: 间隔至少 %d 分钟", MinIntervalMinutes)
		}
	case KindHours:
		if r.Interval < MinIntervalHours {
			return fmt.Errorf("schedule: 间隔至少 %d 小时", MinIntervalHours)
		}
	case KindDaily, KindWeekdays:
		if _, _, err := parseClock(r.Time); err != nil {
			return err
		}
	case KindWeekly:
		if _, _, err := parseClock(r.Time); err != nil {
			return err
		}
		if len(r.Weekdays) == 0 {
			return errors.New("schedule: 每周任务要选至少一天")
		}
		for _, d := range r.Weekdays {
			if d < 0 || d > 6 {
				return fmt.Errorf("schedule: 星期取值 %d 越界（0=周日 … 6=周六）", d)
			}
		}
	case KindMonthly:
		if _, _, err := parseClock(r.Time); err != nil {
			return err
		}
		if r.Day < 1 || r.Day > 31 {
			return fmt.Errorf("schedule: 每月日期 %d 越界（1..31）", r.Day)
		}
	case KindCron:
		if _, err := parseCron(r.Cron); err != nil {
			return err
		}
	default:
		return fmt.Errorf("schedule: 未知规则类型 %q", r.Kind)
	}
	return nil
}

// Next 返回严格晚于 after 的下一次发生时间；没有下一次时返回 false。
//
// after 应当传入「当前时间」或「上一次投递时间」——调度器不用「上次计划时间」，
// 因为停机错过的时段只补最近一次（与 DSH 同口径：逾期的一次性照投，重复任务
// 只补最近错过的那一次）。
func (r Rule) Next(after time.Time) (time.Time, bool) {
	loc := r.Location()
	switch r.Kind {
	case KindOnce:
		at, err := time.Parse(time.RFC3339, r.At)
		if err != nil {
			return time.Time{}, false
		}
		if !at.After(after) {
			return time.Time{}, false
		}
		return at, true
	case KindMinutes:
		if r.Interval < MinIntervalMinutes {
			return time.Time{}, false
		}
		return after.Add(time.Duration(r.Interval) * time.Minute), true
	case KindHours:
		if r.Interval < MinIntervalHours {
			return time.Time{}, false
		}
		return after.Add(time.Duration(r.Interval) * time.Hour), true
	case KindDaily, KindWeekdays:
		h, m, err := parseClock(r.Time)
		if err != nil {
			return time.Time{}, false
		}
		return nextDaily(after.In(loc), h, m, loc, func(d time.Time) bool {
			if r.Kind != KindWeekdays {
				return true
			}
			wd := int(d.Weekday())
			return wd >= 1 && wd <= 5
		})
	case KindWeekly:
		h, m, err := parseClock(r.Time)
		if err != nil {
			return time.Time{}, false
		}
		set := make(map[int]bool, len(r.Weekdays))
		for _, d := range r.Weekdays {
			set[d] = true
		}
		return nextDaily(after.In(loc), h, m, loc, func(d time.Time) bool {
			return set[int(d.Weekday())]
		})
	case KindMonthly:
		h, m, err := parseClock(r.Time)
		if err != nil {
			return time.Time{}, false
		}
		return nextMonthly(after.In(loc), h, m, r.Day, loc)
	case KindCron:
		spec, err := parseCron(r.Cron)
		if err != nil {
			return time.Time{}, false
		}
		return spec.next(after.In(loc), loc)
	}
	return time.Time{}, false
}

// nextDaily 从 after 起找第一个满足 dayOK 的日子，取那天的 h:m。
func nextDaily(after time.Time, h, m int, loc *time.Location, dayOK func(time.Time) bool) (time.Time, bool) {
	// 从今天开始往后找 8 天（一周 + 1）；weekly 的空集合在 Validate 里已挡掉。
	base := time.Date(after.Year(), after.Month(), after.Day(), h, m, 0, 0, loc)
	for i := 0; i < 8; i++ {
		cand := base.AddDate(0, 0, i)
		if !cand.After(after) {
			continue
		}
		if dayOK(cand) {
			return cand, true
		}
	}
	return time.Time{}, false
}

// nextMonthly 找本月或之后某个月的 day 日；该月没有这一天就落在月末。
func nextMonthly(after time.Time, h, m, day int, loc *time.Location) (time.Time, bool) {
	for i := 0; i < 24; i++ {
		first := time.Date(after.Year(), after.Month(), 1, h, m, 0, 0, loc).AddDate(0, i, 0)
		last := first.AddDate(0, 1, -1).Day()
		d := day
		if d > last {
			d = last
		}
		cand := time.Date(first.Year(), first.Month(), d, h, m, 0, 0, loc)
		if cand.After(after) {
			return cand, true
		}
	}
	return time.Time{}, false
}

func parseClock(s string) (int, int, error) {
	parts := strings.Split(strings.TrimSpace(s), ":")
	if len(parts) != 2 {
		return 0, 0, fmt.Errorf("schedule: 时间 %q 需要 HH:MM", s)
	}
	h, err1 := strconv.Atoi(parts[0])
	m, err2 := strconv.Atoi(parts[1])
	if err1 != nil || err2 != nil || h < 0 || h > 23 || m < 0 || m > 59 {
		return 0, 0, fmt.Errorf("schedule: 时间 %q 不是合法的 HH:MM", s)
	}
	return h, m, nil
}

// cronSpec 是解析后的 5 字段表达式。
type cronSpec struct {
	minute, hour, dom, month, dow uint64 // 位图：第 i 位表示取值 i
	domAny, dowAny                bool
}

const (
	cronMinuteRange = 60
	cronHourRange   = 24
	cronDomRange    = 32 // 1..31 用位 1..31
	cronMonthRange  = 13 // 1..12
	cronDowRange    = 7  // 0..6（7 归一化成 0）
)

func parseCron(expr string) (cronSpec, error) {
	fields := strings.Fields(strings.TrimSpace(expr))
	if len(fields) != 5 {
		return cronSpec{}, fmt.Errorf("schedule: cron 需要 5 个字段（分 时 日 月 周），得到 %d 个", len(fields))
	}
	var spec cronSpec
	var err error
	if spec.minute, err = parseCronField(fields[0], 0, 59); err != nil {
		return spec, fmt.Errorf("schedule: cron 分钟: %w", err)
	}
	if spec.hour, err = parseCronField(fields[1], 0, 23); err != nil {
		return spec, fmt.Errorf("schedule: cron 小时: %w", err)
	}
	if spec.dom, err = parseCronField(fields[2], 1, 31); err != nil {
		return spec, fmt.Errorf("schedule: cron 日: %w", err)
	}
	if spec.month, err = parseCronField(fields[3], 1, 12); err != nil {
		return spec, fmt.Errorf("schedule: cron 月: %w", err)
	}
	if spec.dow, err = parseCronField(fields[4], 0, 7); err != nil {
		return spec, fmt.Errorf("schedule: cron 周: %w", err)
	}
	spec.domAny = fields[2] == "*"
	spec.dowAny = fields[4] == "*"
	// 7 与 0 都表示周日。
	if spec.dow&(1<<7) != 0 {
		spec.dow |= 1
		spec.dow &^= 1 << 7
	}
	return spec, nil
}

// parseCronField 解析一个字段：`*`、`a`、`a-b`、`*/n`、`a-b/n`、逗号列表。
func parseCronField(field string, min, max int) (uint64, error) {
	var bits uint64
	for _, part := range strings.Split(field, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			return 0, errors.New("空取值")
		}
		step := 1
		if slash := strings.IndexByte(part, '/'); slash >= 0 {
			n, err := strconv.Atoi(part[slash+1:])
			if err != nil || n < 1 {
				return 0, fmt.Errorf("步长 %q 非法", part[slash+1:])
			}
			step = n
			part = part[:slash]
		}
		lo, hi := min, max
		if part != "*" {
			if dash := strings.IndexByte(part, '-'); dash >= 0 {
				a, err1 := strconv.Atoi(part[:dash])
				b, err2 := strconv.Atoi(part[dash+1:])
				if err1 != nil || err2 != nil {
					return 0, fmt.Errorf("区间 %q 非法", part)
				}
				lo, hi = a, b
			} else {
				v, err := strconv.Atoi(part)
				if err != nil {
					return 0, fmt.Errorf("取值 %q 非法", part)
				}
				lo, hi = v, v
			}
			if lo < min || hi > max || lo > hi {
				return 0, fmt.Errorf("取值 %d-%d 越界（%d..%d）", lo, hi, min, max)
			}
		}
		for v := lo; v <= hi; v += step {
			bits |= 1 << uint(v)
		}
	}
	if bits == 0 {
		return 0, errors.New("没有匹配任何取值")
	}
	return bits, nil
}

// next 从 after 之后扫描到匹配的分钟。上限 4 年，避免不可能满足的表达式空转。
//
// 逐分钟扫描是有意为之：5 个字段的 OR 语义（日与周同时受限时任一匹配即可）用
// 增量算法容易写错，而这条路径一次只跑几毫秒。
func (c cronSpec) next(after time.Time, _ *time.Location) (time.Time, bool) {
	start := after.Truncate(time.Minute).Add(time.Minute)
	const limit = 4 * 366 * 24 * 60
	t := start
	for i := 0; i < limit; i++ {
		if c.matches(t) {
			return t, true
		}
		// Add 走绝对时间，但 t 一直带着 loc：夏令时跳变时本地钟点会跟着跳，
		// 这正是 cron「按本地钟表时间」的语义，不需要额外对齐。
		t = t.Add(time.Minute)
	}
	return time.Time{}, false
}

func (c cronSpec) matches(t time.Time) bool {
	if c.minute&(1<<uint(t.Minute())) == 0 {
		return false
	}
	if c.hour&(1<<uint(t.Hour())) == 0 {
		return false
	}
	if c.month&(1<<uint(int(t.Month()))) == 0 {
		return false
	}
	domOK := c.dom&(1<<uint(t.Day())) != 0
	dowOK := c.dow&(1<<uint(int(t.Weekday()))) != 0
	// 标准 cron：日与周都受限时取「或」，否则取与。
	if c.domAny || c.dowAny {
		return domOK && dowOK
	}
	return domOK || dowOK
}
