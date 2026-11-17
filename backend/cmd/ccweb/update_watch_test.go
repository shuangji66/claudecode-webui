package main

import (
	"context"
	"errors"
	"io"
	"log"
	"sync"
	"testing"
	"time"

	"ccweb/backend/internal/claudebin"
)

type fakeChecker struct {
	mu    sync.Mutex
	calls int
	err   error
}

func (f *fakeChecker) Check(context.Context) (claudebin.CheckResult, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls++
	return claudebin.CheckResult{Latest: "2.1.326"}, f.err
}

func (f *fakeChecker) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls
}

type fakeNotifier struct {
	mu    sync.Mutex
	calls int
}

func (f *fakeNotifier) BroadcastClaudeUpdate() {
	f.mu.Lock()
	f.calls++
	f.mu.Unlock()
}

func (f *fakeNotifier) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls
}

func discardLogger() *log.Logger { return log.New(io.Discard, "", 0) }

// waitCond 轮询等待；这类测试只能说「最终会发生」，不能断言精确时刻。
func waitCond(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("等待超时: %s", what)
}

// 启动即查一次，之后按间隔重复；成功一次就推一次。
func TestUpdateWatchChecksOnStartAndOnEveryTick(t *testing.T) {
	check := &fakeChecker{}
	notify := &fakeNotifier{}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	startClaudeUpdateWatch(ctx, check, notify, 10*time.Millisecond, discardLogger())

	// 先看启动那次：不该等到第一个 tick 才有结果。
	waitCond(t, "启动即检查一次", func() bool { return check.count() >= 1 })
	waitCond(t, "按间隔继续检查", func() bool { return check.count() >= 3 })
	waitCond(t, "每次成功都推送", func() bool { return notify.count() >= 3 })
}

// 检查失败只记日志，不推送，也不能让循环停掉。
func TestUpdateWatchKeepsRunningOnError(t *testing.T) {
	check := &fakeChecker{err: errors.New("registry 502")}
	notify := &fakeNotifier{}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	startClaudeUpdateWatch(ctx, check, notify, 10*time.Millisecond, discardLogger())

	waitCond(t, "失败后继续下一轮", func() bool { return check.count() >= 3 })
	if n := notify.count(); n != 0 {
		t.Fatalf("检查失败推送了 %d 次，want 0", n)
	}
}

// ctx 取消后循环要退出，不能留着 goroutine。
func TestUpdateWatchStopsOnContextCancel(t *testing.T) {
	check := &fakeChecker{}
	ctx, cancel := context.WithCancel(context.Background())
	startClaudeUpdateWatch(ctx, check, &fakeNotifier{}, 5*time.Millisecond, discardLogger())

	waitCond(t, "启动即检查", func() bool { return check.count() >= 1 })
	cancel()
	time.Sleep(30 * time.Millisecond)
	stopped := check.count()

	time.Sleep(50 * time.Millisecond)
	if n := check.count(); n != stopped {
		t.Fatalf("取消后仍在检查（%d → %d）", stopped, n)
	}
}
