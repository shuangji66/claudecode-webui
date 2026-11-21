#!/usr/bin/env node
/**
 * runner.mjs — 内置浏览器 MCP 的驱动层（由 `ccweb mcp-browser` 用 node 启动）。
 *
 * 分工：Go 侧（ccweb mcp-browser）负责 MCP 协议、工具描述、进程与超时；这个脚本
 * 只负责「让浏览器做事」——内核与版本由 playwright 管理（下载、启动参数、无头 profile）。
 *
 * 内核固定是 Chromium 的 headless shell（为什么只有它、为什么不去掉 Firefox，见
 * browserbin 包里 Kernels 上方的实测记录）。要加第二个内核时，除了 Kernels 加一行，
 * 这里要恢复「按内核选 lib.xxx」与对应的启动参数分支。
 *
 * 协议：stdin/stdout 上换行分隔的 JSON。**stdout 只能放协议帧**，日志一律走 stderr。
 *   请求 {"id":1,"cmd":"goto","args":{...}}
 *   响应 {"id":1,"ok":true,"result":{...}} / {"id":1,"ok":false,"error":"..."}
 *
 * 生命周期（对齐 skill 的硬性要求：不许留浏览器进程）：
 *   - stdin 关闭（Go 侧退出/会话结束）→ 关浏览器并退出；
 *   - 收到 SIGTERM/SIGINT → 同上；
 *   - 父进程消失（ppid 变了或变成 1）→ 同上；
 *   - 空闲 idleExitMs 没有任何请求 → 关浏览器并退出；
 *   - 任何未捕获异常 → 尽力关浏览器后以非零码退出。
 * 浏览器本身不常驻在 Go 进程里：关闭时它会收到 SIGTERM，超时再 SIGKILL。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(HERE, '_resolve.js'));

const REF_ATTR = 'data-ccweb-ref';
const DEFAULT_TIMEOUT = 30000;
const IDLE_EXIT_MS = Number(process.env.CCWEB_BROWSER_IDLE_MS || 600000);

let pw = null;
let browser = null;
let context = null;
let page = null;
let launchedAt = '';
let lastUsed = Date.now();
let closing = false;

function log(...args) {
  process.stderr.write(`[runner] ${args.join(' ')}\n`);
}

function loadPlaywright() {
  if (pw) return pw;
  // 优先用运行时目录里那份固定版本；解析失败时给出可执行的排查方向。
  try {
    pw = require('playwright');
  } catch (err) {
    throw new Error(
      `找不到 playwright 包（运行时目录 ${HERE}）：${err.message}。` +
        '请在「设置 → MCP → 内置浏览器」里重新安装运行时。',
    );
  }
  return pw;
}

function viewportOf(args) {
  const v = args && args.viewport;
  if (typeof v === 'string' && /^\d+x\d+$/.test(v)) {
    const [w, h] = v.split('x').map(Number);
    return { width: w, height: h };
  }
  if (v && typeof v === 'object' && v.width && v.height) {
    return { width: Number(v.width), height: Number(v.height) };
  }
  return { width: 1280, height: 800 };
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} 超时（${ms}ms）`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** target 是否在 root 里面（都按真实路径比，符号链接不能把路径带出去）。 */
function withinRoot(root, target) {
  let realRoot = root;
  try {
    realRoot = fs.realpathSync(root);
  } catch {
    /* root 不存在：按传入值比 */
  }
  let probe = target;
  let rest = '';
  // 逐级向上找第一个存在的祖先再拼回剩下的段：截图/本地文件的父目录可能还不存在。
  for (;;) {
    try {
      const real = fs.realpathSync(probe);
      const full = rest ? path.join(real, rest) : real;
      return full === realRoot || full.startsWith(realRoot + path.sep);
    } catch {
      const parent = path.dirname(probe);
      if (parent === probe) return false;
      rest = rest ? path.join(path.basename(probe), rest) : path.basename(probe);
      probe = parent;
    }
  }
}

/**
 * 把入口收进允许的范围：http(s) 与**工作区内**的 file://。
 *
 * 为什么不能放行任意 file://：这十个工具是预放行的（不弹审批），而 url 是模型给的——
 * 页面里的提示注入可以诱导模型 `browser_open file:///etc/...` 再把内容读回对话。
 * 本地文件只在工作区里才有正当用途（看一份自己生成的 HTML）。
 */
function fileURL(raw, root) {
  const abs = path.resolve(root, raw);
  if (!withinRoot(root, abs)) {
    throw new Error(`本地文件只能打开工作区里的：${raw}（当前工作区 ${root}）`);
  }
  return 'file://' + abs;
}

/** 裸域名补 https；相对路径 / 本地文件转 file://（与 skill 的 pw.mjs 同一口径）。 */
function absoluteURL(raw, root = process.cwd()) {
  const s = String(raw || '').trim();
  if (!s) throw new Error('url 不能为空');
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(s)) {
    let protocol = '';
    try {
      protocol = new URL(s).protocol;
    } catch {
      throw new Error(`url 不合法：${s}`);
    }
    if (protocol === 'file:') {
      const abs = fileURL(fileURLToPath(s), root);
      return abs;
    }
    if (protocol !== 'http:' && protocol !== 'https:') {
      throw new Error(`不支持的协议 ${protocol}：只能打开 http(s) 或工作区里的本地文件`);
    }
    return s;
  }
  if (s.startsWith('//')) return 'https:' + s;
  if (s.startsWith('/') || s.startsWith('./') || s.startsWith('../')) return fileURL(s, root);
  if (/^[\w.-]+\.[a-zA-Z]{2,}(:\d+)?(\/|$)/.test(s)) return 'https://' + s;
  return fileURL(s, root);
}

async function ensureLaunched(args) {
  if (browser) {
    // isConnected() 为 false 说明 Chromium 已经没了（NAS 上内存压力会杀掉它）。
    // 不清掉重建的话，之后每个工具都只会回 playwright 的
    // "Target page, context or browser has been closed"，模型只能靠猜。
    if (typeof browser.isConnected !== 'function' || browser.isConnected()) return;
    await browser.close().catch(() => {});
    browser = null;
    context = null;
    page = null;
  }
  const lib = loadPlaywright();
  const timeout = Number((args && args.timeoutMs) || DEFAULT_TIMEOUT);
  // 运行时只装 headless shell（见 browserbin 的 Kernels）：有头启动会去找完整 Chromium，
  // 那时候报的是「可执行文件不存在」，不如在这里说清楚为什么。
  if (args && args.headless === false) {
    throw new Error('内置浏览器只提供无头模式：运行时只装了 headless shell，没有完整 Chromium');
  }
  const launchOpts = {
    headless: true,
    timeout,
    args: ['--disable-dev-shm-usage', '--disable-background-networking'],
  };

  const ctxOpts = {
    viewport: viewportOf(args),
    ignoreHTTPSErrors: !!(args && args.ignoreHTTPSErrors),
    acceptDownloads: true,
  };
  if (args && args.locale) ctxOpts.locale = String(args.locale);
  if (args && args.timezone) ctxOpts.timezoneId = String(args.timezone);
  if (args && args.proxy) ctxOpts.proxy = { server: String(args.proxy) };
  if (args && args.storageState) ctxOpts.storageState = String(args.storageState);

  // 一次完整的「启动内核 → 建上下文 → 开页面」。失败时把已经起了一半的浏览器收掉，
  // 否则降级重试会留下一个孤儿进程。
  const boot = async (extra) => {
    const b = await lib.chromium.launch({ ...launchOpts, ...extra });
    try {
      const c = await b.newContext(ctxOpts);
      const p = await c.newPage();
      return { b, c, p };
    } catch (err) {
      await b.close().catch(() => {});
      throw err;
    }
  };

  try {
    ({ b: browser, c: context, p: page } = await boot({}));
  } catch (err) {
    // 受限环境（容器 / 部分 NAS / 应用沙箱）里内核起不来：Chromium 缺 --no-sandbox。
    // 降级重试一次；包住整段而不是只包 launch——常见的是 launch 成功、newPage 才失败。
    const msg = String((err && err.message) || err);
    if (!/sandbox|SUID|operation not permitted|clone\(|Target page, context or browser has been closed|uid_map|EACCES/i.test(msg)) {
      throw new Error(
        `启动浏览器失败：${msg}。` +
          '如果提示可执行文件不存在，请在「设置 → MCP → 内置浏览器」重新安装运行时。',
      );
    }
    log(`内核在受限沙箱里起不来，降级重试（${msg.split('\n')[0]}）`);
    ({ b: browser, c: context, p: page } = await boot({ args: [...launchOpts.args, '--no-sandbox'] }));
  }
  page.setDefaultTimeout(timeout);
  page.setDefaultNavigationTimeout(timeout);
}

async function currentPage() {
  if (!page) throw new Error('浏览器还没启动：先调用 browser_open（或 browser_launch）');
  return page;
}

/** 在页面里给可交互元素打 ref，并返回结构化的元素清单。 */
async function collectRefs(p, limit) {
  return p.evaluate(
    ({ attr, limit }) => {
      const sel = [
        'a[href]',
        'button',
        'input:not([type="hidden"])',
        'select',
        'textarea',
        'summary',
        '[role="button"]',
        '[role="link"]',
        '[role="checkbox"]',
        '[role="tab"]',
        '[role="menuitem"]',
        '[role="option"]',
        '[contenteditable="true"]',
        '[onclick]',
      ].join(',');
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return false;
        const st = getComputedStyle(el);
        return st.visibility !== 'hidden' && st.display !== 'none' && Number(st.opacity) > 0;
      };
      const nodes = [...document.querySelectorAll(sel)].filter(visible).slice(0, limit);
      // 先清掉上一轮的标记：页面局部重渲染之后旧 ref 可能指向别的元素。
      for (const el of document.querySelectorAll(`[${attr}]`)) el.removeAttribute(attr);
      return nodes.map((el, i) => {
        const ref = 'e' + (i + 1);
        el.setAttribute(attr, ref);
        const text = (el.innerText || el.value || el.getAttribute('aria-label') ||
          el.getAttribute('placeholder') || el.getAttribute('title') || '')
          .replace(/\s+/g, ' ')
          .trim();
        return {
          ref,
          role: el.getAttribute('role') || el.tagName.toLowerCase(),
          name: text.slice(0, 100),
          type: el.getAttribute('type') || '',
          disabled: el.disabled === true,
        };
      });
    },
    { attr: REF_ATTR, limit: Math.max(1, Math.min(600, limit || 200)) },
  );
}

function refSelector(ref) {
  const v = String(ref || '').trim();
  // ref 是我们在 snapshot 时打的 e1、e2…，只可能是这个形状。不校验的话，
  // 模型把整段选择器塞进来会拼出一个语法错误的选择器，报错信息指向 Playwright 内部，
  // 看不出「这个 ref 不是上一页的」。
  if (!/^e\d{1,4}$/.test(v)) {
    throw new Error(`ref 格式不对：${JSON.stringify(v)}。ref 只能是 browser_snapshot 返回的 e1/e2…，换页后要重新取`);
  }
  return `[${REF_ATTR}="${v}"]`;
}

function locatorFor(p, args) {
  if (args && args.ref) return p.locator(refSelector(args.ref)).first();
  if (args && args.selector) return p.locator(String(args.selector)).first();
  if (args && args.text) return p.getByText(String(args.text), { exact: false }).first();
  throw new Error('需要 ref / selector / text 三者之一（ref 来自 browser_snapshot）');
}

/* ------------------------------------------------------------------ 命令 */

const commands = {
  async hello(args) {
    const lib = loadPlaywright();
    return {
      playwright: (() => {
        try {
          return require('playwright/package.json').version;
        } catch {
          return '';
        }
      })(),
      browsers: ['chromium'],
      running: !!browser,
    };
  },

  async launch(args) {
    await ensureLaunched(args);
    return { version: browser.version(), url: page.url() };
  },

  async open(args) {
    await ensureLaunched(args);
    const p = await currentPage();
    const url = absoluteURL(args && args.url);
    const timeout = Number((args && args.timeoutMs) || DEFAULT_TIMEOUT);
    const waitUntil = (args && args.waitUntil) || 'load';
    const resp = await p.goto(url, { waitUntil, timeout });
    const status = resp ? resp.status() : 0;
    return {
      url: p.url(),
      title: await p.title(),
      status,
      refs: await collectRefs(p, args && args.maxRefs),
    };
  },

  async goto(args) {
    return commands.open(args);
  },

  async snapshot(args) {
    const p = await currentPage();
    const refs = await collectRefs(p, args && args.maxRefs);
    return { url: p.url(), title: await p.title(), refs };
  },

  async text(args) {
    const p = await currentPage();
    const scope = (args && args.selector) || 'body';
    const text = await p.locator(scope).first().innerText({ timeout: DEFAULT_TIMEOUT });
    const limit = Number((args && args.maxChars) || 12000);
    return {
      url: p.url(),
      title: await p.title(),
      text: text.length > limit ? text.slice(0, limit) + '\n…（已截断）' : text,
    };
  },

  async click(args) {
    const p = await currentPage();
    const loc = locatorFor(p, args);
    const timeout = Number((args && args.timeoutMs) || DEFAULT_TIMEOUT);
    const before = p.url();
    await loc.click({ timeout });
    // 点击常触发导航：给一个短窗口让地址栏落定，再回读；没有导航也不额外等待。
    await p.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
    return { url: p.url(), navigated: p.url() !== before, title: await p.title() };
  },

  async type(args) {
    const p = await currentPage();
    const loc = locatorFor(p, args);
    const timeout = Number((args && args.timeoutMs) || DEFAULT_TIMEOUT);
    const value = String((args && args.text) || '');
    if (args && args.clear) await loc.fill('', { timeout });
    await loc.fill(value, { timeout });
    if (args && args.submit) {
      await loc.press('Enter', { timeout });
      await p.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
    }
    return { url: p.url(), filled: value.length };
  },

  async press(args) {
    const p = await currentPage();
    const key = String((args && args.key) || 'Enter');
    await p.keyboard.press(key);
    await p.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
    return { url: p.url(), key };
  },

  async screenshot(args) {
    const p = await currentPage();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const target = String((args && args.path) || path.join('.ccweb-browser', `shot-${stamp}.png`));
    const out = path.isAbsolute(target) ? target : path.resolve(process.cwd(), target);
    // 截图落点必须在工作区里（Go 侧也挡一次，这里是第二道）：这十个工具是预放行的，
    // path 又是模型给的，任意落点等于给它一个「覆盖工作区外任意可写文件」的口子。
    if (!withinRoot(process.cwd(), out)) {
      throw new Error(`截图只能存到工作区里：${out}（当前工作区 ${process.cwd()}）`);
    }
    fs.mkdirSync(path.dirname(out), { recursive: true });
    await p.screenshot({
      path: out,
      fullPage: !!(args && args.fullPage),
      type: out.endsWith('.jpg') || out.endsWith('.jpeg') ? 'jpeg' : 'png',
    });
    return { path: out, bytes: fs.statSync(out).size, url: p.url() };
  },

  async eval(args) {
    const p = await currentPage();
    const script = String((args && args.script) || '');
    if (!script.trim()) throw new Error('script 不能为空');
    // Playwright 把字符串当表达式求值：`document.title`、`({n: document.links.length})`
    // 都行。不要自己 new Function——那会被页面的 CSP 拦掉，报错还很难懂。
    const value = await withTimeout(
      p.evaluate(script),
      Number((args && args.timeoutMs) || DEFAULT_TIMEOUT),
      '页面脚本',
    );
    let json;
    try {
      json = JSON.stringify(value ?? null);
    } catch {
      json = String(value);
    }
    const limit = Number((args && args.maxChars) || 20000);
    return { value: json.length > limit ? json.slice(0, limit) + '…（已截断）' : json };
  },

  async status() {
    return {
      running: !!browser,
      version: browser ? browser.version() : '',
      url: page ? page.url() : '',
      pages: context ? context.pages().length : 0,
      launchedAt: browser ? launchedAt : '',
    };
  },

  async close() {
    await shutdown('close');
    // 关掉浏览器就结束进程：会话里不会再需要它，留着只是内存。
    setTimeout(() => void exitWith('已关闭'), 0);
    return { closed: true };
  },
};

/* --------------------------------------------------------------- 生命周期 */

async function shutdown(reason) {
  if (closing) return;
  closing = true;
  try {
    if (browser) {
      await withTimeout(browser.close(), 15000, '关闭浏览器').catch((err) => log('关闭浏览器失败:', err.message));
    }
  } finally {
    browser = null;
    context = null;
    page = null;
    // 正常收尾（模型调 close / stdin 关闭 / 收到信号）不打日志：本项目的约定是
    // 只在异常时输出（关不掉的那种失败上面已经 log 过了）。`reason` 仍保留在
    // 调用方，方便以后需要时把结论带进错误消息。
  }
}

function write(obj) {
  try {
    process.stdout.write(JSON.stringify(obj) + '\n');
  } catch (err) {
    log('写 stdout 失败:', err.message);
  }
}

async function handle(req) {
  const cmd = String(req.cmd || '');
  const fn = commands[cmd];
  if (!fn) throw new Error(`未知命令: ${cmd}`);
  // 只有真正需要浏览器的命令才自动启动；open/launch 自己要带内核参数，先起默认的会冲突。
  if (!['hello', 'status', 'close', 'launch', 'open', 'goto'].includes(cmd)) {
    await ensureLaunched({});
  }
  if (cmd === 'launch' || cmd === 'open' || cmd === 'goto') launchedAt = new Date().toISOString();
  lastUsed = Date.now();
  return fn(req.args || {});
}

// 命令串行执行：playwright 的 page 不是并发安全的，两条命令同时跑会互相打断导航。
let chain = Promise.resolve();
function enqueue(task) {
  chain = chain.then(task, task);
  return chain;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function startStdin() {
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', async (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let req;
      try {
        req = JSON.parse(line);
      } catch (err) {
        write({ id: null, ok: false, error: `请求解析失败: ${err.message}` });
        continue;
      }
      enqueue(async () => {
        try {
          const result = await handle(req);
          write({ id: req.id, ok: true, result });
        } catch (err) {
          write({ id: req.id, ok: false, error: String((err && err.message) || err) });
        }
      });
    }
  });
  // EOF = 调用方（ccweb mcp-browser）不在了：等手上那条命令跑完再收尾。
  // 不等的话「一次管道喂几条命令」会丢掉最后一条的响应（命令还没 in-flight 完，
  // 进程已经退出）。上限 8 秒：真卡住时不能因为它永远不退出。
  const drainThenExit = () => {
    void Promise.race([chain.catch(() => {}), sleep(8000)]).then(() => exitWith('stdin 已关闭'));
  };
  process.stdin.on('end', drainThenExit);
  process.stdin.on('close', drainThenExit);
  process.stdin.resume();
}

let exiting = false;
async function exitWith(reason) {
  if (exiting) return;
  exiting = true;
  await shutdown(reason);
  process.exit(0);
}

function startWatchdogs() {
  const ppid = process.ppid;
  setInterval(() => {
    if (process.ppid !== ppid || process.ppid === 1) void exitWith('父进程已退出');
  }, 2000).unref();
  setInterval(() => {
    if (browser && Date.now() - lastUsed > IDLE_EXIT_MS) void exitWith('空闲超时');
  }, 5000).unref();
  process.on('SIGTERM', () => void exitWith('收到 SIGTERM'));
  process.on('SIGINT', () => void exitWith('收到 SIGINT'));
  process.on('uncaughtException', (err) => {
    log('未捕获异常:', err && err.stack ? err.stack : String(err));
    void exitWith('未捕获异常');
  });
  process.on('unhandledRejection', (err) => {
    log('未处理的 Promise 拒绝:', err && err.stack ? err.stack : String(err));
  });
}

startWatchdogs();
startStdin();
write({ id: 0, ok: true, result: { ready: true, pid: process.pid } });
