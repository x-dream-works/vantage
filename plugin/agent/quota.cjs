"use strict";
// Vantage —— Codex 账户额度采集。只读、只取额度数值，绝不传 PII。
// 被 reconcile 每轮调用一次（1h 节流，见 reconcile.cjs），结果贴到当轮所有 Codex 记录的 quota 字段。
// 双通道：app-server（主，codex 自维护登录态/token 刷新，无过期问题）→ wham/usage（降级，直读 auth.json）。
// 两条都是非公开接口：低频调用 + 任何失败返回 null（靠服务端粘性合并沿用上次值，不阻塞采集）。
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const https = require("node:https");
const http = require("node:http");
const net = require("node:net");
const tls = require("node:tls");
const { spawn, spawnSync } = require("node:child_process");
const core = require("./core.cjs");

const AUTH_PATH = path.join(os.homedir(), ".codex", "auth.json");
const ENDPOINT = "https://chatgpt.com/backend-api/wham/usage";
const ENDPOINT_HOST = "chatgpt.com";
const ENDPOINT_PATH = "/backend-api/wham/usage";
const TIMEOUT_MS = 30000;
// app-server 短命子进程的整体预算（启动+握手+RPC），参考 Codexometer 的 15s。
const APPSERVER_TIMEOUT_MS = 15000;

/** clientInfo.version 用插件清单里的版本号，读不到就退化成 "0"（对端只做展示，不校验）。 */
function pluginVersion() {
  try {
    return require("../.claude-plugin/plugin.json").version || "0";
  } catch {
    return "0";
  }
}

/**
 * 从环境变量挑代理 URL。顺序：HTTPS_PROXY > HTTP_PROXY > ALL_PROXY（大小写都认）。
 * 纯函数，便于测试。
 */
function pickProxyFromEnv(env) {
  const e = env || {};
  return (
    e.HTTPS_PROXY || e.https_proxy ||
    e.HTTP_PROXY || e.http_proxy ||
    e.ALL_PROXY || e.all_proxy ||
    ""
  );
}

/**
 * 解析 Windows 注册表 Internet Settings 的系统代理。
 * enable=0 或 server 空 → ""。
 * server 可能是 "127.0.0.1:7890" 或 "http=h;https=s" 多协议格式 → 取 https（无则取首个）。
 * 结果归一成带 http:// scheme 的 URL。纯函数，便于测试。
 */
function parseWinRegistryProxy({ enable, server } = {}) {
  if (!enable || !server) return "";
  const parts = String(server).split(";").map((s) => s.trim()).filter(Boolean);
  let candidate = "";
  for (const p of parts) {
    const m = /^([a-z]+)=(.+)$/i.exec(p);
    if (m) {
      if (/^https$/i.test(m[1])) candidate = m[2]; // https 优先（wham 走 443）
      else if (!candidate) candidate = m[2];
    } else if (!candidate) {
      candidate = p;
    }
  }
  if (!candidate) return "";
  return /^https?:\/\//i.test(candidate) ? candidate : "http://" + candidate;
}

/**
 * 读 Windows 注册表里的系统代理（Clash/v2ray「设为系统代理」就写这里）。
 * 只在 win32 跑；reg query 隐藏执行、只读、5s 超时；任何失败返回 {}。
 * Codex(走系统代理)能连 chatgpt 时，这里就能拿到同一个代理。
 */
function readWinSystemProxy() {
  if (process.platform !== "win32") return {};
  try {
    const out = spawnSync(
      "reg",
      ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings"],
      { windowsHide: true, encoding: "utf8", timeout: 5000 }
    );
    const text = (out && out.stdout) || "";
    let enable = 0;
    let server = "";
    const em = /ProxyEnable\s+REG_\S+\s+(\S+)/i.exec(text);
    if (em) enable = parseInt(em[1], em[1].startsWith("0x") ? 16 : 10) || 0;
    const sm = /ProxyServer\s+REG_SZ\s+(.+)/i.exec(text);
    if (sm) server = sm[1].trim();
    return { enable, server };
  } catch {
    return {};
  }
}

/**
 * 选择 wham 请求该走的代理：env(HTTPS_PROXY/HTTP_PROXY/ALL_PROXY) 优先，
 * 否则 win32 读系统代理注册表。其余平台/无代理返回 ""。readRegistry 可注入便于测试。
 */
function readProxy(options = {}) {
  const fromEnv = pickProxyFromEnv(options.env || process.env);
  if (fromEnv) return fromEnv;
  if ((options.platform || process.platform) !== "win32") return "";
  const readRegistry = options.readRegistry || readWinSystemProxy;
  try {
    return parseWinRegistryProxy(readRegistry());
  } catch {
    return "";
  }
}

function readAuth() {
  try {
    const a = JSON.parse(fs.readFileSync(AUTH_PATH, "utf8"));
    const t = a.tokens || {};
    return { accessToken: t.access_token, accountId: t.account_id };
  } catch {
    return {};
  }
}

/**
 * 【主通道】经 codex app-server JSON-RPC 读额度（Codexometer 验证过的路线）。
 * 起短命 `codex app-server --stdio` 子进程：initialize 握手 → account/rateLimits/read → 杀进程。
 * codex 自己管理登录态和 token 刷新，绕开 wham 直连时 auth.json 里 token 过期 401 的问题。
 * 输出映射成 wham shape（rate_limit.primary_window.*），服务端/看板零改动。
 * 任何失败（无 codex / 超时 / 协议错 / 响应缺字段）resolve null，绝不抛。
 * options.command/args 可注入 mock 进程（测试用）。
 */
function fetchCodexQuotaViaAppServer(options = {}) {
  return new Promise((resolve) => {
    const command = options.command || "codex";
    const args = options.args || ["app-server", "--stdio"];
    // win32 上 npm 全局装的是 codex.cmd shim，直接 spawn 打不开（Node 出于安全禁了 .cmd）。
    // → shell:true + 手工引好的完整命令串（Node 会正确交给 cmd.exe 执行）；
    // 收尾 taskkill /T 杀整棵进程树（cmd 的孙进程 kill() 够不着）。
    const useShellWrapper = process.platform === "win32";
    const spawnee = useShellWrapper
      ? `"${command}" ${args.map((a) => `"${a}"`).join(" ")}`
      : command;

    let child;
    try {
      child = useShellWrapper
        ? spawn(spawnee, { windowsHide: true, stdio: ["pipe", "pipe", "ignore"], shell: true })
        : spawn(spawnee, args, { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
    } catch (e) {
      core.log("quota: app-server 启动失败 " + String(e));
      resolve(null);
      return;
    }

    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.stdin.end();
      } catch {}
      if (useShellWrapper && child.pid) {
        // 杀 cmd 进程树（windowsHide:黑窗静默 + /T 连孙进程一起 + /F 强杀）
        try {
          spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
            windowsHide: true,
            timeout: 5000,
          });
        } catch {}
      } else {
        try {
          child.kill();
        } catch {}
      }
      resolve(value);
    };
    const timer = setTimeout(() => {
      core.log("quota: app-server 超时");
      finish(null);
    }, APPSERVER_TIMEOUT_MS);

    // ENOENT（未装 codex）等启动错误异步到达
    child.on("error", (e) => {
      core.log("quota: app-server 无法启动 " + String(e));
      finish(null);
    });

    let buf = "";
    child.stdout.on("data", (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let msg = null;
        try {
          msg = JSON.parse(line);
        } catch {
          continue; // 非 JSON 行（banner 等）跳过
        }
        if (msg.id === 1) {
          // 握手回包 → 发 initialized 通知 + 额度查询
          try {
            child.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
            child.stdin.write(JSON.stringify({ method: "account/rateLimits/read", id: 3 }) + "\n");
          } catch (e) {
            core.log("quota: app-server 写入失败 " + String(e));
            finish(null);
          }
        } else if (msg.id === 3) {
          if (msg.error) {
            core.log("quota: app-server RPC 错误 " + String(msg.error.message));
            finish(null);
            return;
          }
          const mapped = mapAppServerQuota(msg.result);
          if (!mapped) {
            core.log("quota: app-server 响应缺 rateLimits.primary.usedPercent");
            finish(null);
            return;
          }
          core.log(`quota: app-server 命中 plan=${mapped.plan_type} used=${mapped.rate_limit.primary_window.used_percent}%`);
          finish({ ...mapped, observed_at: new Date().toISOString() });
        }
        // 其余 id / 通知一律跳过
      }
    });
    child.stdout.on("end", () => {
      core.log("quota: app-server 提前退出");
      finish(null);
    });

    // 第一步握手
    try {
      child.stdin.write(
        JSON.stringify({
          method: "initialize",
          id: 1,
          params: { clientInfo: { name: "vantage", title: "Vantage", version: pluginVersion() } },
        }) + "\n"
      );
    } catch (e) {
      core.log("quota: app-server 写入失败 " + String(e));
      finish(null);
    }
  });
}

/**
 * app-server 响应（rateLimits.primary/secondary.usedPercent + resetsAt，unix 秒）
 * → wham shape（rate_limit.primary_window.used_percent + reset_at unix 秒）。
 * 服务端 merge.js 会把 reset_at*1000 转 ISO。纯函数，便于测试。
 */
function mapAppServerQuota(result) {
  const rl = result && result.rateLimits;
  const primary = rl && rl.primary;
  if (!primary || typeof primary.usedPercent !== "number") return null;
  const reachedType = rl.rateLimitReachedType || "";
  return {
    plan_type: rl.planType || null,
    rate_limit: {
      primary_window: {
        used_percent: primary.usedPercent,
        limit_reached: !!reachedType,
        reset_at: primary.resetsAt || null,
      },
    },
    source: "app-server",
  };
}

/**
 * 拉取 Codex 账户当前额度：app-server 主通道 → wham 降级。
 * 任一成功即返回；全失败返回 null。options.viaAppServer/viaWham 可注入（测试用）。
 */
async function fetchCodexQuota(options = {}) {
  const viaAppServer = options.viaAppServer || fetchCodexQuotaViaAppServer;
  const viaWham = options.viaWham || fetchCodexQuotaWham;
  const q = await viaAppServer(options);
  if (q) return q;
  core.log("quota: app-server 未命中，回退 wham");
  return viaWham(options);
}

/**
 * 【降级通道】wham/usage 直连。
 * 成功返回 wham/usage 的完整响应 + observed_at；
 * 任何失败（无凭证 / 网络 / 非200 / 解析错 / 无 rate_limit）返回 null，绝不抛。
 * 服务端应从 rate_limit.primary_window 解析已用百分比。
 * 注意：完整响应包含 user_id / email，服务端必须在入库前脱敏或丢弃。
 * observed_at 为本次测量时刻。
 */
function fetchCodexQuotaWham() {
  return new Promise((resolve) => {
    const { accessToken, accountId } = readAuth();
    if (!accessToken) {
      core.log("quota: 无 codex access_token，跳过");
      resolve(null);
      return;
    }
    const headers = {
      Authorization: "Bearer " + accessToken,
      Accept: "application/json",
      "User-Agent": "codex-cli/1.0",
    };
    if (accountId) headers["chatgpt-account-id"] = accountId;

    // 响应处理：直连和代理隧道共用（都是 IncomingMessage）。
    const onResponse = (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        if (res.statusCode !== 200) {
          core.log(`quota: wham 非200 status=${res.statusCode}`);
          resolve(null);
          return;
        }
        try {
          const d = JSON.parse(body);
          if (!d.rate_limit || d.rate_limit.primary_window == null) {
            core.log("quota: wham 响应无 rate_limit/primary_window");
            resolve(null);
            return;
          }
          resolve({ ...d, observed_at: new Date().toISOString() });
        } catch (e) {
          core.log("quota: wham 解析失败 " + String(e));
          resolve(null);
        }
      });
    };

    const proxy = readProxy();
    if (!proxy) {
      // 直连（无代理环境/系统代理）
      const req = https.request(ENDPOINT, { method: "GET", headers, timeout: TIMEOUT_MS }, onResponse);
      req.on("timeout", () => {
        req.destroy();
        core.log("quota: wham 超时");
        resolve(null);
      });
      req.on("error", (e) => {
        core.log("quota: wham 请求失败 " + String(e));
        resolve(null);
      });
      req.end();
      return;
    }
    // 走代理：CONNECT 隧道 → TLS → HTTP 请求（Codex 能通 chatgpt 时,这条也通）
    requestViaProxy(proxy, headers, onResponse, resolve);
  });
}

/**
 * 经 HTTP 代理 CONNECT 隧道发 wham 请求。纯 Node 实现，不依赖外部包。
 * 任何阶段失败（连代理 / CONNECT 被拒 / TLS / 超时 / 请求错）都 resolve(null) + 写日志，绝不抛。
 */
function requestViaProxy(proxyUrl, headers, onResponse, resolve) {
  const fail = (label, e) => {
    core.log(`quota: wham ${label} ${String((e && e.message) || e)}`);
    resolve(null);
  };
  let u;
  try {
    u = new URL(proxyUrl);
  } catch {
    fail("代理 URL 无效", new Error(proxyUrl));
    return;
  }
  const sock = net.connect(parseInt(u.port || "80", 10), u.hostname);
  sock.setTimeout(TIMEOUT_MS);
  sock.on("timeout", () => {
    sock.destroy();
    fail("代理超时", new Error("timeout"));
  });
  sock.on("error", (e) => fail("代理连接失败", e));
  sock.once("connect", () => {
    let line = `CONNECT ${ENDPOINT_HOST}:443 HTTP/1.1\r\nHost: ${ENDPOINT_HOST}:443\r\n`;
    if (u.username) {
      line +=
        "Proxy-Authorization: Basic " +
        Buffer.from(decodeURIComponent(u.username) + ":" + decodeURIComponent(u.password || "")).toString("base64") +
        "\r\n";
    }
    sock.write(line + "\r\n");
  });
  let buf = "";
  sock.on("data", function onData(d) {
    buf += d.toString();
    if (!buf.includes("\r\n\r\n")) return;
    sock.removeListener("data", onData);
    if (!/^HTTP\/1\.[01] 200/.test(buf)) {
      sock.destroy();
      fail("代理拒绝 CONNECT", new Error(buf.split("\r\n")[0]));
      return;
    }
    const tlsSock = tls.connect({ socket: sock, servername: ENDPOINT_HOST }, () => {
      const req = http.request(
        {
          host: ENDPOINT_HOST,
          path: ENDPOINT_PATH,
          method: "GET",
          headers,
          timeout: TIMEOUT_MS,
          createConnection: () => tlsSock,
        },
        onResponse
      );
      req.on("timeout", () => {
        req.destroy();
        fail("超时", new Error("timeout"));
      });
      req.on("error", (e) => fail("请求失败", e));
      req.end();
    });
    tlsSock.on("error", (e) => fail("TLS 失败", e));
  });
}

/**
 * 选择本轮真正贴到记录上的 quota：本轮拉到新值就用新值；
 * 否则在保质期内沿用上次缓存的值（网络抖动/节流跳过时，记录照样带 quota）；
 * 缓存过保质期或从无缓存时返回 null。纯函数，不产生任何子进程/窗口。
 */
function pickQuota(fetched, cached, maxAgeMs, now = Date.now()) {
  if (fetched) return fetched;
  if (
    cached &&
    cached.value &&
    Number.isFinite(Number(cached.at)) &&
    now - Number(cached.at) <= maxAgeMs
  ) {
    return cached.value;
  }
  return null;
}

module.exports = {
  fetchCodexQuota,
  fetchCodexQuotaViaAppServer,
  fetchCodexQuotaWham,
  mapAppServerQuota,
  pickQuota,
  pickProxyFromEnv,
  parseWinRegistryProxy,
  readProxy,
};
