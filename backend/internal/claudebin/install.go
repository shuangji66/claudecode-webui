package claudebin

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"crypto/sha512"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"time"
)

// maxBinaryBytes 是解包单个文件的上限，防止损坏或恶意包把磁盘写满。
const maxBinaryBytes = 1 << 30 // 1 GiB

// checkCacheTTL 是可用版本列表的缓存时间：registry 不会分秒级变化，
// 每次打开设置页都拉 600KB 的 packument 没必要。
const checkCacheTTL = 5 * time.Minute

// distInfo 是 npm 包里的 dist 字段（只取用得到的）。
type distInfo struct {
	Tarball      string `json:"tarball"`
	Integrity    string `json:"integrity"`
	UnpackedSize int64  `json:"unpackedSize"`
	Size         int64  `json:"size"`
}

type manifest struct {
	Name    string   `json:"name"`
	Version string   `json:"version"`
	Dist    distInfo `json:"dist"`
}

// install 完成「取 manifest → 流式下载并解包 → 校验完整性 → 试运行 → 落盘」。
//
// 下载与解包是同一遍：平台包里的 claude 是唯一的 366MB 文件，先存 tgz 再解开
// 会在 NAS 上多占 170MB，没必要。
func (m *Manager) install(ctx context.Context, version, source string) error {
	if m.platform == "" {
		return fmt.Errorf("claudebin: 当前平台 %s/%s 没有对应的 claude 平台包", runtime.GOOS, runtime.GOARCH)
	}
	man, err := m.fetchManifest(ctx, source, version)
	if err != nil {
		return err
	}
	if man.Version != version {
		return fmt.Errorf("claudebin: registry 返回的版本是 %s，与请求的 %s 不一致", man.Version, version)
	}
	if man.Dist.Tarball == "" {
		return errors.New("claudebin: registry 没有返回 tarball 地址")
	}

	stage, err := os.MkdirTemp(m.root, ".stage-")
	if err != nil {
		return fmt.Errorf("claudebin: 创建临时目录: %w", err)
	}
	defer os.RemoveAll(stage)
	bin := filepath.Join(stage, "claude")

	if err := m.downloadAndExtract(ctx, man, bin); err != nil {
		return err
	}
	if err := os.Chmod(bin, 0o755); err != nil {
		return fmt.Errorf("claudebin: 设置可执行位: %w", err)
	}

	m.setPhase(PhaseVerifying)
	if err := verifyBinary(ctx, bin, version); err != nil {
		return err
	}

	// 目录改名是原子的：前端不会看到半装好的版本目录。
	// MkdirTemp 建的是 0700，这里放宽到 0755，与版本根目录一致。
	if err := os.Chmod(stage, 0o755); err != nil {
		return fmt.Errorf("claudebin: 设置版本目录权限: %w", err)
	}
	final := filepath.Join(m.root, version)
	if err := os.RemoveAll(final); err != nil {
		return fmt.Errorf("claudebin: 清理残留目录: %w", err)
	}
	if err := os.Rename(stage, final); err != nil {
		return fmt.Errorf("claudebin: 落盘版本目录: %w", err)
	}
	return nil
}

// fetchManifest 取单个版本的平台包元数据（只有几 KB，比整份 packument 便宜）。
func (m *Manager) fetchManifest(ctx context.Context, source, version string) (manifest, error) {
	reg := strings.TrimRight(m.registries[source], "/")
	url := fmt.Sprintf("%s/@anthropic-ai/claude-code-%s/%s", reg, m.platform, version)
	var man manifest
	if err := m.getJSON(ctx, url, &man); err != nil {
		return manifest{}, err
	}
	if man.Name == "" || man.Dist.Tarball == "" {
		return manifest{}, fmt.Errorf("claudebin: %s 没有返回有效的包元数据", url)
	}
	return man, nil
}

// fetchVersions 取最新版本与近期可用版本；dist-tags.latest 与版本列表都来自同一份
// 精简 packument（Accept: install-v1）。
func (m *Manager) fetchVersions(ctx context.Context, source string) ([]string, string, error) {
	reg := strings.TrimRight(m.registries[source], "/")
	var pk struct {
		DistTags map[string]string          `json:"dist-tags"`
		Versions map[string]json.RawMessage `json:"versions"`
	}
	if err := m.getJSON(ctx, reg+"/@anthropic-ai/claude-code", &pk); err != nil {
		return nil, "", err
	}
	all := make([]string, 0, len(pk.Versions))
	for v := range pk.Versions {
		if validVersion(v) {
			all = append(all, v)
		}
	}
	if len(all) == 0 {
		return nil, "", errors.New("claudebin: registry 没有返回任何可用版本")
	}
	sort.Slice(all, func(i, j int) bool { return Compare(all[i], all[j]) > 0 })
	latest := pk.DistTags["latest"]
	if latest == "" {
		latest = all[0]
	}
	all = append([]string{latest}, removeString(all, latest)...)
	if len(all) > 40 {
		all = all[:40]
	}
	return all, latest, nil
}

// getJSON 带超时与体积上限地取一份 JSON。
func (m *Manager) getJSON(ctx context.Context, url string, dst any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return fmt.Errorf("claudebin: 构造请求: %w", err)
	}
	req.Header.Set("Accept", "application/vnd.npm.install-v1+json")
	resp, err := m.client.Do(req)
	if err != nil {
		return fmt.Errorf("claudebin: 请求 %s: %w", url, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("claudebin: %s 返回 HTTP %d", url, resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil {
		return fmt.Errorf("claudebin: 读取响应: %w", err)
	}
	if err := json.Unmarshal(body, dst); err != nil {
		return fmt.Errorf("claudebin: 解析响应: %w", err)
	}
	return nil
}

// downloadAndExtract 把 tarball 流式解出 package/claude，同时按 dist.integrity
// 校验整个压缩包的 sha512。校验在解包之后做，失败时 stage 目录已被删除。
func (m *Manager) downloadAndExtract(ctx context.Context, man manifest, dst string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, man.Dist.Tarball, nil)
	if err != nil {
		return fmt.Errorf("claudebin: 构造下载请求: %w", err)
	}
	resp, err := m.client.Do(req)
	if err != nil {
		return fmt.Errorf("claudebin: 下载 %s: %w", man.Dist.Tarball, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("claudebin: 下载 %s 返回 HTTP %d", man.Dist.Tarball, resp.StatusCode)
	}

	total := resp.ContentLength
	if total <= 0 {
		total = man.Dist.Size
	}
	m.setProgress(total)

	hash := sha512.New()
	stream := io.TeeReader(&progressReader{r: resp.Body, m: m}, hash)
	gz, err := gzip.NewReader(stream)
	if err != nil {
		return fmt.Errorf("claudebin: 解压失败（不是有效的 gzip 包）: %w", err)
	}
	defer gz.Close()

	tr := tar.NewReader(gz)
	found := false
	for {
		hdr, err := tr.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return fmt.Errorf("claudebin: 解析 tar: %w", err)
		}
		if hdr.Typeflag != tar.TypeReg {
			continue
		}
		if name := path.Clean(hdr.Name); name != "package/claude" && name != "claude" {
			continue
		}
		if hdr.Size <= 0 || hdr.Size > maxBinaryBytes {
			return fmt.Errorf("claudebin: 二进制大小异常（%d 字节）", hdr.Size)
		}
		m.setPhase(PhaseExtracting)
		f, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o755)
		if err != nil {
			return fmt.Errorf("claudebin: 写入二进制: %w", err)
		}
		_, copyErr := io.CopyN(f, tr, hdr.Size)
		closeErr := f.Close()
		if copyErr != nil {
			return fmt.Errorf("claudebin: 解包二进制: %w", copyErr)
		}
		if closeErr != nil {
			return fmt.Errorf("claudebin: 关闭二进制: %w", closeErr)
		}
		found = true
		break
	}

	// tar 在条目结束处就 break 了，gzip 尾部还没读，sha512 也不完整。
	if _, err := io.Copy(io.Discard, stream); err != nil {
		return fmt.Errorf("claudebin: 读取剩余数据: %w", err)
	}
	if !found {
		return errors.New("claudebin: 压缩包里没有 claude 二进制")
	}
	if man.Dist.Integrity != "" {
		got := "sha512-" + base64.StdEncoding.EncodeToString(hash.Sum(nil))
		if got != man.Dist.Integrity {
			return fmt.Errorf("claudebin: 完整性校验失败（期望 %s，实际 %s）；可能是镜像内容与官方不一致", man.Dist.Integrity, got)
		}
	}
	return nil
}

// verifyBinary 先跑一次 `--version` 再落盘：架构不对（例如把 musl 包装到 glibc）
// 或文件被截断时，这里就会失败，用户看到的是"安装失败"而不是"会话起不来"。
func verifyBinary(ctx context.Context, bin, version string) error {
	cctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	out, err := exec.CommandContext(cctx, bin, "--version").CombinedOutput()
	if err != nil {
		return fmt.Errorf("claudebin: 下载的二进制无法运行: %v；输出: %s", err, tailText(string(out), 300))
	}
	if !strings.Contains(string(out), version) {
		return fmt.Errorf("claudebin: 版本校验失败，期望 %s，实际输出 %q", version, tailText(string(out), 200))
	}
	return nil
}

// progressReader 把「已下载字节数」回写到 job，供前端进度条使用。
type progressReader struct {
	r io.Reader
	m *Manager
}

func (p *progressReader) Read(b []byte) (int, error) {
	n, err := p.r.Read(b)
	if n > 0 {
		p.m.addProgress(int64(n))
	}
	return n, err
}

func removeString(list []string, want string) []string {
	out := make([]string, 0, len(list))
	for _, v := range list {
		if v != want {
			out = append(out, v)
		}
	}
	return out
}

func tailText(s string, n int) string {
	s = strings.TrimSpace(s)
	if len(s) <= n {
		return s
	}
	return "…" + s[len(s)-n:]
}
