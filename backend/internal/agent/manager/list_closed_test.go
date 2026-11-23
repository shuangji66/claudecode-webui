package manager

import (
	"io"
	"testing"

	"ccweb/backend/internal/agent/session"
)

type nopTransport struct{}

func (nopTransport) Read(p []byte) (int, error)  { return 0, io.EOF }
func (nopTransport) Write(p []byte) (int, error) { return len(p), nil }
func (nopTransport) Close() error                { return nil }

// List() 不该把已退出的会话报成活着。
//
// 进程自己退出（OOM / kill / CLI fatal）后，记录要等下一次 createWith 里的 pruneClosed
// 才被摘掉；中间这段它一直躺在这张表里。网关会把 List 里每一条都标成 live:true，
// 于是侧栏那一行看起来和「活着但空闲」一模一样（连灰点都没有）；而
// handleCreateSession 用它判断 wasLive，命中就吞掉「进程被拉起来」那次广播。
// 口径必须与 infoByID 一致（那里早就把 closed 当不存在）。
func TestListHidesClosedSessions(t *testing.T) {
	m := &Manager{
		sessions:        map[string]*session.Session{},
		metas:           map[string]meta{},
		closingSessions: map[string]chan struct{}{},
	}
	id := "11111111-2222-4333-8444-555555555555"
	s := session.New(id, "/tmp", nopTransport{}, nil)
	_ = s.Close()
	m.sessions[id] = s
	m.metas[id] = meta{}

	if got := m.List(); len(got) != 0 {
		t.Fatalf("List 仍报出已退出的会话: %+v", got)
	}
	if _, live := m.infoByID(id); live {
		t.Fatal("infoByID 也不该认为它活着")
	}
}
