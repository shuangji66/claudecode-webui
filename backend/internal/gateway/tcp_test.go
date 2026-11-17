package gateway

import (
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"ccweb/backend/internal/settings"
)

const testTCPPassword = "s3cret-123"

// setTCP 直接写设置（不走 HTTP），用来准备鉴权/端口状态。
// 需要真实监听的测试另外调 srv.ListenTCP。
func setTCP(t *testing.T, srv *Server, enabled bool, pwd string, port int) {
	t.Helper()
	patch := settings.Patch{TCPEnabled: &enabled, TCPPort: &port}
	if pwd != "" {
		patch.TCPPassword = &pwd
	}
	if _, err := srv.d.Settings.Apply(patch); err != nil {
		t.Fatalf("Apply TCP 设置: %v", err)
	}
}

func infoBody(t *testing.T, rec *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("解析 /api/info: %v（body=%s）", err, rec.Body.String())
	}
	return body
}

// login 走 /api/auth/login，返回状态码与会话令牌。
func login(t *testing.T, h http.Handler, pwd string) (int, string) {
	t.Helper()
	payload, _ := json.Marshal(map[string]string{"password": pwd})
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/auth/login", strings.NewReader(string(payload)))
	req.Header.Set("Content-Type", "application/json")
	h.ServeHTTP(rec, req)
	var body struct {
		Token string `json:"token"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &body)
	return rec.Code, body.Token
}

// TCP 通道必须登录；unix socket 是本机可信入口，直接免密。
// 密码本身不能当 Bearer 用——必须先换会话令牌。
func TestTCPChannelRequiresLoginUnixBypasses(t *testing.T) {
	srv, _ := newTestServer(t, "")
	setTCP(t, srv, true, testTCPPassword, 3141)

	// TCP 无凭据：401
	rec := httptest.NewRecorder()
	srv.TCPHandler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/info", nil))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("TCP 无凭据 = %d, want 401", rec.Code)
	}

	// 密码本身不能当 Bearer 用
	req := httptest.NewRequest(http.MethodGet, "/api/info", nil)
	req.Header.Set("Authorization", "Bearer "+testTCPPassword)
	rec = httptest.NewRecorder()
	srv.TCPHandler().ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("TCP 直接带密码 = %d, want 401", rec.Code)
	}

	// 错误密码登录：401
	if code, _ := login(t, srv.TCPHandler(), "wrong-pass-1"); code != http.StatusUnauthorized {
		t.Fatalf("错误密码登录 = %d, want 401", code)
	}

	// 正确密码换令牌
	code, token := login(t, srv.TCPHandler(), testTCPPassword)
	if code != http.StatusOK || token == "" {
		t.Fatalf("登录 = %d token=%q", code, token)
	}

	// 带会话令牌访问
	req = httptest.NewRequest(http.MethodGet, "/api/info", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rec = httptest.NewRecorder()
	srv.TCPHandler().ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("TCP 登录后 = %d: %s", rec.Code, rec.Body.String())
	}
	body := infoBody(t, rec)
	if body["auth_required"] != true || body["auth_mode"] != "password" || body["channel"] != "tcp" {
		t.Fatalf("TCP info = %v/%v/%v", body["auth_required"], body["auth_mode"], body["channel"])
	}

	// query 上的令牌（WS 只能走 query）
	rec = httptest.NewRecorder()
	srv.TCPHandler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/info?token="+token, nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("TCP query 令牌 = %d, want 200", rec.Code)
	}

	// unix socket 免密放行
	rec = httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/info", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("unix 无凭据 = %d, want 200（socket 不应校验 TCP 密码）", rec.Code)
	}
	body = infoBody(t, rec)
	if body["auth_required"] != false || body["auth_mode"] != "none" || body["channel"] != "unix" {
		t.Fatalf("unix info = %v/%v/%v", body["auth_required"], body["auth_mode"], body["channel"])
	}
}

// 端口访问关闭时登录接口必须拒绝（没有可登录的入口）。
func TestLoginRequiresEnabledPort(t *testing.T) {
	srv, _ := newTestServer(t, "")
	pwd := testTCPPassword
	if _, err := srv.d.Settings.Apply(settings.Patch{TCPPassword: &pwd}); err != nil {
		t.Fatalf("设置密码: %v", err)
	}
	if code, _ := login(t, srv.TCPHandler(), testTCPPassword); code != http.StatusConflict {
		t.Fatalf("关闭端口访问时登录 = %d, want 409", code)
	}
}

// 旧的 CCWEB_AUTH_TOKEN 部署也要能从鉴权页登录：令牌本身就是凭据。
func TestLoginAcceptsEnvToken(t *testing.T) {
	srv, _ := newTestServer(t, "secret")

	code, token := login(t, srv.TCPHandler(), "secret")
	if code != http.StatusOK || token != "secret" {
		t.Fatalf("令牌登录 = %d token=%q, want 200/secret", code, token)
	}
	// 输错时是「凭据不正确」，不是「端口访问没开」——否则会误导用令牌的部署。
	if code, _ := login(t, srv.TCPHandler(), "wrong"); code != http.StatusUnauthorized {
		t.Fatalf("错误令牌登录 = %d, want 401", code)
	}
	// unix 通道同样能换（登录接口本身不需要鉴权）。
	if code, token := login(t, srv.Handler(), "secret"); code != http.StatusOK || token != "secret" {
		t.Fatalf("unix 令牌登录 = %d token=%q", code, token)
	}
}

// unix 通道上的环境变量令牌仍然生效（旧部署行为不变）。
func TestUnixTokenStillEnforced(t *testing.T) {
	srv, _ := newTestServer(t, "secret")
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/info", nil))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("unix 无令牌 = %d, want 401", rec.Code)
	}
	req := httptest.NewRequest(http.MethodGet, "/api/info", nil)
	req.Header.Set("Authorization", "Bearer secret")
	rec = httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("unix 带令牌 = %d, want 200", rec.Code)
	}
	if mode := infoBody(t, rec)["auth_mode"]; mode != "token" {
		t.Fatalf("auth_mode = %v, want token", mode)
	}
}

// TCP 通道挂在根路径：即使部署配置了 baseurl，也不该要求前缀、更不该注入 <base>。
func TestTCPHandlerServesRootWithoutBase(t *testing.T) {
	useSPAFS(t, "<html><head></head><body>app</body></html>")
	srv, _ := newTestServer(t, "")
	srv.d.Cfg.BaseURL = "/app/ccweb"

	rec := httptest.NewRecorder()
	srv.TCPHandler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("TCP / = %d, want 200", rec.Code)
	}
	if body := rec.Body.String(); strings.Contains(body, "<base") {
		t.Fatalf("TCP 通道不应注入 <base>：%s", body)
	}

	// 同一进程的 unix 通道仍然只认前缀。
	rec = httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/", nil))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("unix 裸路径 = %d, want 404（必须走 baseurl 前缀）", rec.Code)
	}
	rec = httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/app/ccweb/", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("unix 前缀 / = %d, want 200", rec.Code)
	}
	if body := rec.Body.String(); !strings.Contains(body, `<base href="/app/ccweb/">`) {
		t.Fatalf("unix 通道缺少注入的 base：%s", body)
	}
}

// 开关默认关闭；打开必须同时给密码；关闭后监听断开、旧会话失效。
func TestPutSettingsEnableDisableTCP(t *testing.T) {
	srv, _ := newTestServer(t, "")
	t.Cleanup(srv.CloseTCP)
	port := freePort(t)

	// 没有密码就开启：400
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodPut, "/api/settings",
		strings.NewReader(`{"tcp_enabled":true,"tcp_port":`+strconv.Itoa(port)+`}`)))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("无密码开启 = %d, want 400: %s", rec.Code, rec.Body.String())
	}
	if _, listening, _ := srv.TCPStatus(); listening {
		t.Fatal("校验失败不应开始监听")
	}

	// 打开 + 设密码
	body := `{"tcp_enabled":true,"tcp_port":` + strconv.Itoa(port) + `,"tcp_password":"` + testTCPPassword + `"}`
	rec = httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodPut, "/api/settings", strings.NewReader(body)))
	if rec.Code != http.StatusOK {
		t.Fatalf("开启 = %d: %s", rec.Code, rec.Body.String())
	}
	if got, listening, errText := srv.TCPStatus(); !listening || got != port {
		t.Fatalf("监听状态 = %d/%v/%q, want %d/true", got, listening, errText, port)
	}
	if cur := srv.d.Settings.Get(); !cur.TCPEnabled || cur.TCPPort != port || cur.TCPPasswordHash == "" {
		t.Fatalf("设置 = %+v", cur)
	}

	// 新端口要求登录
	res, err := http.Get("http://127.0.0.1:" + strconv.Itoa(port) + "/api/info")
	if err != nil {
		t.Fatalf("访问新端口: %v", err)
	}
	_, _ = io.Copy(io.Discard, res.Body)
	_ = res.Body.Close()
	if res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("新端口 /api/info = %d, want 401", res.StatusCode)
	}

	code, token := login(t, srv.TCPHandler(), testTCPPassword)
	if code != http.StatusOK || token == "" {
		t.Fatalf("登录 = %d token=%q", code, token)
	}

	// 关闭：响应先到，随后监听断开、会话清空
	rec = httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodPut, "/api/settings",
		strings.NewReader(`{"tcp_enabled":false,"tcp_port":`+strconv.Itoa(port)+`}`)))
	if rec.Code != http.StatusOK {
		t.Fatalf("关闭 = %d: %s", rec.Code, rec.Body.String())
	}
	if cur := srv.d.Settings.Get(); cur.TCPEnabled {
		t.Fatal("设置里仍显示开启")
	}
	waitNoListener(t, srv)

	// 关闭后旧会话不再有效（即便直接打 TCP handler）
	req := httptest.NewRequest(http.MethodGet, "/api/info", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rec = httptest.NewRecorder()
	srv.TCPHandler().ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("关闭后旧会话 = %d, want 401", rec.Code)
	}
	if code, _ := login(t, srv.TCPHandler(), testTCPPassword); code != http.StatusConflict {
		t.Fatalf("关闭后登录 = %d, want 409", code)
	}
}

func waitNoListener(t *testing.T, srv *Server) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if _, listening, _ := srv.TCPStatus(); !listening {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("端口访问关闭后监听仍在")
}

// 换端口：新端口可用，旧端口停止接受新连接。
func TestPutSettingsRebindsTCPPort(t *testing.T) {
	srv, _ := newTestServer(t, "")
	t.Cleanup(srv.CloseTCP)
	first := freePort(t)
	setTCP(t, srv, true, testTCPPassword, first)
	if err := srv.ListenTCP(first); err != nil {
		t.Fatalf("监听首个端口: %v", err)
	}

	second := freePort(t)
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodPut, "/api/settings",
		strings.NewReader(`{"tcp_port":`+strconv.Itoa(second)+`}`)))
	if rec.Code != http.StatusOK {
		t.Fatalf("换端口 = %d: %s", rec.Code, rec.Body.String())
	}
	if got, listening, _ := srv.TCPStatus(); !listening || got != second {
		t.Fatalf("新监听 = %d/%v, want %d", got, listening, second)
	}
	if cur := srv.d.Settings.Get(); cur.TCPEnabled != true || cur.TCPPort != second {
		t.Fatalf("设置 = %+v", cur)
	}
	// 旧端口不再接受连接
	ln, err := net.Listen("tcp", "127.0.0.1:"+strconv.Itoa(first))
	if err != nil {
		t.Fatalf("旧端口仍被占用: %v", err)
	}
	_ = ln.Close()
}

// 端口被占用时必须 400，且保持原监听与配置。
func TestPutSettingsRejectsBusyPort(t *testing.T) {
	srv, _ := newTestServer(t, "")
	t.Cleanup(srv.CloseTCP)
	first := freePort(t)
	setTCP(t, srv, true, testTCPPassword, first)
	if err := srv.ListenTCP(first); err != nil {
		t.Fatalf("监听首个端口: %v", err)
	}

	blocker, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("占用端口: %v", err)
	}
	defer blocker.Close()
	busy := blocker.Addr().(*net.TCPAddr).Port

	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodPut, "/api/settings",
		strings.NewReader(`{"tcp_port":`+strconv.Itoa(busy)+`}`)))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("占用端口 = %d, want 400: %s", rec.Code, rec.Body.String())
	}
	if srv.d.Settings.Get().TCPPort != first {
		t.Fatalf("失败时不该改配置: %d", srv.d.Settings.Get().TCPPort)
	}
	if got, listening, _ := srv.TCPStatus(); !listening || got != first {
		t.Fatalf("失败时旧监听应保留: %d/%v", got, listening)
	}
}

// 端口越界在 bind 之前就该被挡掉。
func TestPutSettingsRejectsInvalidPort(t *testing.T) {
	srv, _ := newTestServer(t, "")
	for _, port := range []int{0, 1024, 70000} {
		rec := httptest.NewRecorder()
		srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodPut, "/api/settings",
			strings.NewReader(`{"tcp_port":`+strconv.Itoa(port)+`}`)))
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("端口 %d = %d, want 400", port, rec.Code)
		}
	}
	if srv.d.Settings.Get().TCPPort != settings.DefaultTCPPort {
		t.Fatalf("配置被改动: %d", srv.d.Settings.Get().TCPPort)
	}
}

// WebSocket 与 HTTP 走同一套通道鉴权：升级前就要挡掉没登录的连接。
func TestTCPWebSocketRequiresLogin(t *testing.T) {
	srv, _ := newTestServer(t, "")
	setTCP(t, srv, true, testTCPPassword, 3141)

	rec := httptest.NewRecorder()
	srv.TCPHandler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/ws", nil))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("TCP /ws 无凭据 = %d, want 401", rec.Code)
	}

	code, token := login(t, srv.TCPHandler(), testTCPPassword)
	if code != http.StatusOK {
		t.Fatalf("登录 = %d", code)
	}
	// 带会话令牌后不再是 401（httptest.ResponseRecorder 不支持 Hijack，升级本身会失败）。
	rec = httptest.NewRecorder()
	srv.TCPHandler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/ws?token="+token, nil))
	if rec.Code == http.StatusUnauthorized {
		t.Fatal("TCP /ws 带会话令牌不应被鉴权挡下")
	}

	// unix 通道免密。
	rec = httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/ws", nil))
	if rec.Code == http.StatusUnauthorized {
		t.Fatal("unix /ws 不该要求 TCP 密码")
	}
}

// 关闭端口后立刻重新开启同一端口：旧连接的延迟关闭不能把新 listener 一起带走。
func TestDisableThenEnableQuicklyKeepsNewListener(t *testing.T) {
	srv, _ := newTestServer(t, "")
	t.Cleanup(srv.CloseTCP)
	port := freePort(t)
	setTCP(t, srv, true, testTCPPassword, port)
	if err := srv.ListenTCP(port); err != nil {
		t.Fatalf("初次监听: %v", err)
	}

	put := func(body string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodPut, "/api/settings", strings.NewReader(body)))
		return rec
	}
	if rec := put(`{"tcp_enabled":false,"tcp_port":` + strconv.Itoa(port) + `}`); rec.Code != http.StatusOK {
		t.Fatalf("关闭 = %d: %s", rec.Code, rec.Body.String())
	}
	// 立刻重开同一端口：listener 已在关闭时同步释放，这里必须 bind 成功。
	if rec := put(`{"tcp_enabled":true,"tcp_port":` + strconv.Itoa(port) + `}`); rec.Code != http.StatusOK {
		t.Fatalf("立刻重开 = %d: %s", rec.Code, rec.Body.String())
	}

	// 等过 500ms 的延迟关闭窗口，新监听必须仍活着。
	time.Sleep(700 * time.Millisecond)
	if _, listening, errText := srv.TCPStatus(); !listening {
		t.Fatalf("新监听被旧连接的延迟关闭误伤: %q", errText)
	}
	res, err := http.Get("http://127.0.0.1:" + strconv.Itoa(port) + "/api/info")
	if err != nil {
		t.Fatalf("访问新监听: %v", err)
	}
	_, _ = io.Copy(io.Discard, res.Body)
	_ = res.Body.Close()
	if res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("新监听 /api/info = %d, want 401", res.StatusCode)
	}
	if code, _ := login(t, srv.TCPHandler(), testTCPPassword); code != http.StatusOK {
		t.Fatalf("重开后登录 = %d, want 200", code)
	}
}

// freePort 找一个当前空闲的本机端口。bind 后立刻释放，只用于测试。
func freePort(t *testing.T) int {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("找空闲端口: %v", err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	_ = ln.Close()
	return port
}
