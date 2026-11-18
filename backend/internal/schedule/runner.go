// 调度循环：到期 → 投递 → 记一条投递记录 → 算下一次。
//
// 这一层不碰 agent：真正的投递（起会话、发 prompt、必要时新建对话）由调用方给的
// deliver 回调实现（gateway），回调返回它实际投进了哪个对话，用于
// TargetNewReuse 的「首次新建后沿用」。
//
// 时间口径（与 DSH 对齐）：
//   - 停机期间错过的时段不逐条补投，只按「当前时间」重算下一次；
//     逾期的一次性任务照投（它就是该发生但还没发生的那一次）。
//   - 同一条任务两次投递之间至少间隔 MinDeliveryGap，避免「立即执行」刚跑完
//     又赶上 tick。
//   - 投递失败也推进下一次并记下原因：否则工作区被删这类永久失败会每 30 秒刷一次。
package schedule

import (
	"context"
	"errors"
	"log"
	"sync"
	"time"
)

// DefaultInterval 是调度循环的 tick 间隔。
//
// 30 秒足够贴合「分钟级」规则（最小单位就是分钟），也不会让进程频繁醒来。
const DefaultInterval = 30 * time.Second

// MinDeliveryGap 是同一条任务两次投递之间的最小间隔。
const MinDeliveryGap = time.Minute

// DeliverFunc 投递一条任务，返回实际投递到的对话 id（新建对话时就是新建的那个）。
type DeliverFunc func(ctx context.Context, t Task, fire time.Time) (string, error)

// ErrTooSoon 表示这条任务刚投递过，还没到最小间隔。
var ErrTooSoon = errors.New("schedule: 这条任务刚投递过，请稍后再试")

// Runner 调度全部任务。
type Runner struct {
	store    *Store
	deliver  DeliverFunc
	logger   *log.Logger
	now      func() time.Time
	interval time.Duration
	gap      time.Duration

	// mu 串行化投递：tick 与「立即执行」不能同时跑同一条任务。
	mu sync.Mutex
}

// NewRunner 构造调度器。logger 可以为 nil。
func NewRunner(store *Store, deliver DeliverFunc, logger *log.Logger) *Runner {
	return &Runner{
		store:    store,
		deliver:  deliver,
		logger:   logger,
		now:      time.Now,
		interval: DefaultInterval,
		gap:      MinDeliveryGap,
	}
}

// Start 起调度循环，直到 ctx 取消。启动时先跑一次，补投停机期间到期的任务。
func (r *Runner) Start(ctx context.Context) {
	ticker := time.NewTicker(r.interval)
	defer ticker.Stop()
	r.Tick(ctx)
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			r.Tick(ctx)
		}
	}
}

// Tick 处理一轮到期任务，返回本轮投递成功的条数。
//
// 导出是为了让测试用假时钟直接驱动，不必等真实 ticker。
func (r *Runner) Tick(ctx context.Context) int {
	now := r.now()
	delivered := 0
	for _, t := range r.store.List() {
		if !t.Due(now) {
			continue
		}
		if t.LastDeliveredAt != nil && now.Sub(*t.LastDeliveredAt) < r.gap {
			continue
		}
		if err := r.deliverOne(ctx, t, *t.NextRun, true); err != nil {
			r.logf("投递失败（任务 %s）: %v", t.ID, err)
			continue
		}
		delivered++
	}
	return delivered
}

// RunNow 立即投递一次，保留原来的下一次计划时间。
//
// 刚投过（小于最小间隔）时返回 ErrTooSoon——界面上那颗按钮据此置灰。
func (r *Runner) RunNow(ctx context.Context, id string) error {
	t, ok := r.store.Get(id)
	if !ok {
		return ErrNotFound
	}
	now := r.now()
	if t.LastDeliveredAt != nil && now.Sub(*t.LastDeliveredAt) < r.gap {
		return ErrTooSoon
	}
	return r.deliverOne(ctx, t, now, false)
}

// deliverOne 投递并把结果写回任务。advance 为 true 时推进下一次计划时间。
func (r *Runner) deliverOne(ctx context.Context, t Task, fire time.Time, advance bool) error {
	r.mu.Lock()
	defer r.mu.Unlock()

	convID, err := r.deliver(ctx, t, fire)
	_, updateErr := r.store.UpdateRun(t.ID, func(x *Task) error {
		now := r.now()
		at := now
		x.LastDeliveredAt = &at
		if err != nil {
			x.LastError = err.Error()
		} else {
			x.LastError = ""
		}
		// 首次投递新建的对话要记下来，下次才谈得上「复用」。
		if convID != "" && x.Target.ConversationID == "" {
			x.Target.ConversationID = convID
		}
		d := Delivery{At: at, ConversationID: convID, Prompt: t.Prompt}
		if err != nil {
			d.Error = err.Error()
		}
		x.Deliveries = append(x.Deliveries, d)
		if len(x.Deliveries) > MaxDeliveries {
			x.Deliveries = x.Deliveries[len(x.Deliveries)-MaxDeliveries:]
		}
		if !advance {
			return nil
		}
		if x.Rule.Kind == KindOnce {
			x.Status = StatusEnded
			x.NextRun = nil
			return nil
		}
		if next, ok := x.Rule.Next(now); ok {
			x.NextRun = &next
			return nil
		}
		x.Status = StatusEnded
		x.NextRun = nil
		return nil
	})
	if updateErr != nil {
		return updateErr
	}
	return err
}

// FirstRun 计算一条新任务的下一次发生时间；没有未来发生时返回 false。
func FirstRun(r Rule, from time.Time) (time.Time, bool) {
	return r.Next(from)
}

func (r *Runner) logf(format string, args ...any) {
	if r.logger != nil {
		r.logger.Printf(format, args...)
	}
}
