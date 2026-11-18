package trimapi

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"path/filepath"
	"strings"
	"testing"
)

// fakeGateway 在临时目录里起一个 unix socket HTTP 服务，模拟飞牛 apiscope 网关。
//
// 只回一个固定的 JSON，同时把收到的请求记下来：契约里最容易写错的就是
// 外壳字段名（reqId/req/appName/data）与 Authorization 头。
type fakeGateway struct {
	socket string
	reqs   []envelope
	auth   []string
	reply  string
	status int
}

func newFakeGateway(t *testing.T, reply string) *fakeGateway {
	t.Helper()
	f := &fakeGateway{socket: filepath.Join(t.TempDir(), "trim.sock"), reply: reply, status: http.StatusOK}
	ln, err := net.Listen("unix", f.socket)
	if err != nil {
		t.Fatalf("listen unix: %v", err)
	}
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != requestPath {
			http.NotFound(w, r)
			return
		}
		var env envelope
		_ = json.NewDecoder(r.Body).Decode(&env)
		f.reqs = append(f.reqs, env)
		f.auth = append(f.auth, r.Header.Get("Authorization"))
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(f.status)
		_, _ = w.Write([]byte(f.reply))
	})}
	go func() { _ = srv.Serve(ln) }()
	t.Cleanup(func() {
		_ = srv.Shutdown(context.Background())
	})
	return f
}

func (f *fakeGateway) client(token string) *Client {
	return New(f.socket, "ClaudeCode", func() string { return token })
}

func TestListSendsEnvelopeAndAuth(t *testing.T) {
	gw := newFakeGateway(t, `{"reqId":"1","code":0,"msg":"","data":{"paths":["/vol1/home/user"]}}`)
	dirs, err := gw.client("tok").List(1000)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(dirs) != 1 || dirs[0] != "/vol1/home/user" {
		t.Fatalf("dirs = %v", dirs)
	}
	if len(gw.reqs) != 1 {
		t.Fatalf("请求次数 = %d", len(gw.reqs))
	}
	got := gw.reqs[0]
	if got.Req != "trim.file.getUserAccessibleFolders" {
		t.Errorf("req = %q", got.Req)
	}
	if got.AppName != "ClaudeCode" {
		t.Errorf("appName = %q", got.AppName)
	}
	if got.ReqID == "" {
		t.Error("reqId 不该为空：网关原样回带它，排障全靠它")
	}
	var data map[string]any
	if err := json.Unmarshal(got.Data, &data); err != nil {
		t.Fatalf("data 不是 JSON: %v", err)
	}
	if data["uid"] != float64(1000) {
		t.Errorf("data.uid = %v", data["uid"])
	}
	if gw.auth[0] != "Bearer tok" {
		t.Errorf("Authorization = %q", gw.auth[0])
	}
}

func TestListNullPathsBecomesEmpty(t *testing.T) {
	gw := newFakeGateway(t, `{"code":0,"msg":"","data":{"paths":null}}`)
	// settings 层的教训：nil 切片会被序列化成 null，前端 map 一下就白屏。
	dirs, err := gw.client("tok").List(1000)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if dirs == nil || len(dirs) != 0 {
		t.Fatalf("dirs = %#v，应为空切片", dirs)
	}
}

func TestRemoveSendsPathAndChecksSuc(t *testing.T) {
	gw := newFakeGateway(t, `{"code":0,"msg":"","data":{"suc":true}}`)
	if err := gw.client("tok").Remove(1000, "/vol1/home/user"); err != nil {
		t.Fatalf("Remove: %v", err)
	}
	var data map[string]any
	if err := json.Unmarshal(gw.reqs[0].Data, &data); err != nil {
		t.Fatalf("data 不是 JSON: %v", err)
	}
	if data["path"] != "/vol1/home/user" || data["uid"] != float64(1000) {
		t.Fatalf("data = %v", data)
	}

	gw2 := newFakeGateway(t, `{"code":0,"msg":"","data":{"suc":false}}`)
	if err := gw2.client("tok").Remove(1000, "/vol1/home/user"); err == nil {
		t.Fatal("suc=false 必须报错，否则界面会显示「已撤销」而实际没撤销")
	}
}

func TestCallMapsGatewayError(t *testing.T) {
	gw := newFakeGateway(t, `{"code":200004,"msg":"scope denied","data":null}`)
	_, err := gw.client("tok").List(1000)
	if err == nil {
		t.Fatal("code != 0 必须报错")
	}
	var ge *Error
	if !errors.As(err, &ge) {
		t.Fatalf("err = %v，应为 *Error", err)
	}
	if ge.Code != 200004 {
		t.Errorf("code = %d", ge.Code)
	}
	if !strings.Contains(err.Error(), "trim.file.getUserAccessibleFolders") {
		t.Errorf("错误信息要带 req，便于定位 scope：%v", err)
	}
}

func TestNoToken(t *testing.T) {
	gw := newFakeGateway(t, `{"code":0}`)
	_, err := gw.client("").List(1000)
	if !errors.Is(err, ErrNoToken) {
		t.Fatalf("err = %v，应为 ErrNoToken", err)
	}
	if len(gw.reqs) != 0 {
		t.Fatal("没有 token 时不该发请求")
	}
}

// 不在飞牛里跑（socket 不存在）时必须给出可读的原因，而不是一句 connection refused。
func TestSocketMissing(t *testing.T) {
	c := New(filepath.Join(t.TempDir(), "nope.sock"), "ClaudeCode", func() string { return "tok" })
	_, err := c.List(1000)
	if err == nil {
		t.Fatal("socket 不存在应报错")
	}
	if !strings.Contains(err.Error(), "连不上飞牛应用网关") || !strings.Contains(err.Error(), "nope.sock") {
		t.Fatalf("err = %v", err)
	}
}

// token 每次现读：飞牛重新注册应用后会换掉它，缓存一份就是 401。
func TestTokenReadPerCall(t *testing.T) {
	gw := newFakeGateway(t, `{"code":0,"msg":"","data":{"paths":[]}}`)
	tok := "first"
	c := New(gw.socket, "ClaudeCode", func() string { return tok })
	if _, err := c.List(1000); err != nil {
		t.Fatalf("List: %v", err)
	}
	tok = "second"
	if _, err := c.List(1000); err != nil {
		t.Fatalf("List: %v", err)
	}
	if gw.auth[1] != "Bearer second" {
		t.Fatalf("Authorization = %q，token 必须每次现读", gw.auth[1])
	}
}

// 网关缺 token 时会回一套别的 JSON（code 是字符串），解码失败也要说清是 HTTP 几。
func TestUnparsableResponse(t *testing.T) {
	gw := newFakeGateway(t, `{"code":"not_found","message":"api not found"}`)
	gw.status = http.StatusNotFound
	_, err := gw.client("tok").List(1000)
	if err == nil {
		t.Fatal("应报错")
	}
	if !strings.Contains(err.Error(), "404") {
		t.Fatalf("err = %v，应带 HTTP 状态码", err)
	}
}
