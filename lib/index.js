// dsh-local-proxy
//
// 只做两件事：
//   1) 发现本机代理端口：先看代理环境变量，再退回 Windows 系统代理注册表；
//   2) 把它配成 DSH 可用：装上进程内 dispatcher，并把代理变量发布给子进程。
//
// 明确不做：不检测代理是否可通、不扫端口、不解析 PAC、不处理 TUN、不做跨平台。
// 硬约束：任何一步失败都降级为「什么都不做」，绝不让原本可用的直连失效。
//
// 注意：DSH 自带模块一律用动态 import + try/catch。静态 import 一旦在未来的 DSH
// 版本上解析失败，会导致整个 profile 加载失败（DSH 起不来）；动态 import 只会留一行日志。
import { appendFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

const NAME = "dsh-local-proxy";
/** DSH home 由启动器写进 process.env.DSH_HOME；取不到就退回 ~/.dsh。日志放这里，不依赖本机用户名。 */
const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), ".dsh");
const LOG_PATH = join(DSH_HOME, "dsh-local-proxy.log");
const DEFAULT_NO_PROXY = "localhost,127.0.0.1,::1";

export const name = NAME;

/** 双通道记录：DSH 自己的 logger + 一个固定文件，便于直接读取验证。 */
function makeLogger(ctx) {
  return (message) => {
    const line = `${new Date().toISOString()} [${NAME}] ${message}`;
    try {
      ctx.logger?.info?.(line);
    } catch {
      /* logger 可选 */
    }
    try {
      appendFileSync(LOG_PATH, `${line}\n`, "utf8");
    } catch {
      /* 日志仅尽力而为 */
    }
  };
}

/**
 * 把候选值规范成可用的 HTTP 代理地址。
 * 只接受 http/https 协议、只接受本机回环地址；其余一律返回 undefined。
 */
function normalizeProxyUrl(candidate) {
  const raw = String(candidate ?? "").trim();
  if (raw === "") return undefined;
  const withScheme = raw.includes("://") ? raw : `http://${raw}`;
  let url;
  try {
    url = new URL(withScheme);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") return undefined;
  const auth = url.username === "" ? "" : `${url.username}${url.password === "" ? "" : `:${url.password}`}@`;
  return `${url.protocol}//${auth}${url.host}`;
}

/**
 * 解析注册表 ProxyServer 的两种写法：
 *   "127.0.0.1:7892"
 *   "http=127.0.0.1:7892;https=127.0.0.1:7892"
 */
function parseProxyServer(raw) {
  const text = String(raw ?? "").trim();
  if (text === "") return undefined;
  if (!text.includes("=")) return normalizeProxyUrl(text);
  const byScheme = new Map();
  for (const part of text.split(";")) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    byScheme.set(part.slice(0, index).trim().toLowerCase(), part.slice(index + 1).trim());
  }
  return normalizeProxyUrl(byScheme.get("https") ?? byScheme.get("http"));
}

/** 读 Windows 系统代理。代理软件开了「系统代理」开关，就会写这两个值。 */
function readWindowsSystemProxy(log) {
  if (process.platform !== "win32") return undefined;
  const key = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";
  const regExe = `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\reg.exe`;
  const query = (name) => {
    try {
      return execFileSync(regExe, ["query", key, "/v", name], { encoding: "utf8", windowsHide: true });
    } catch {
      return execFileSync("reg", ["query", key, "/v", name], { encoding: "utf8", windowsHide: true });
    }
  };
  try {
    const enabled = query("ProxyEnable");
    if (!/0x1\b/i.test(enabled)) {
      log("system proxy: ProxyEnable is not 1");
      return undefined;
    }
    const matched = /ProxyServer\s+REG_SZ\s+(.+)/.exec(query("ProxyServer"));
    const url = parseProxyServer(matched?.[1]);
    log(`system proxy: ${url ?? "(unparsable)"}`);
    return url;
  } catch (error) {
    log(`system proxy read failed: ${error?.message ?? String(error)}`);
    return undefined;
  }
}

async function activate(ctx, log) {
  log(`activate (node ${process.version}, pid ${process.pid})`);

  const launchEnv = await import("@deepseek-ai/dsh-launch-environment");
  const httpProxy = await import("@deepseek-ai/dsh-http-proxy");

  try {
    log(`resolve undici -> ${import.meta.resolve("undici")}`);
  } catch {
    /* 纯诊断信息，拿不到也无所谓 */
  }

  const snapshot = launchEnv.launchEnvironmentOf(ctx);

  // ---- 1) 发现端口 ----
  // 优先级（依据见登记册 SC-0018 / SC-0019）：
  //   ① .env 里「用户显式写的」代理 —— 人工覆盖，仍然最优先；
  //   ② Windows 系统代理注册表 —— 代理软件实时维护，永远最新；
  //   ③ 进程继承来的代理变量 —— 仅兜底。
  // 为什么把 ③ 降到兜底：本插件必须把代理变量写进进程环境（子进程继承是它修 shell 里
  // git/curl 的手段），而 DSH 重启会继承上一代的环境。若让 ③ 优先，旧端口就会一代代
  // 传下去并压过正确的注册表值，形成单向陷阱——而且删掉 .env 也救不回来。
  // 注意：判定「用户显式写的」必须用 getFrom([...]) 单独问，不能用 get()——
  // get() 按 SOURCE_ORDER 会先返回 process 层，正好是这里要忽略的那层。
  let proxyUrl;
  let source;

  let explicitUrl;
  let explicitName;
  for (const entry of ["HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY"]) {
    const hit = snapshot.getFrom(entry, ["project-env", "user-env"]);
    const found = normalizeProxyUrl(hit?.value);
    if (found !== undefined) {
      explicitUrl = found;
      explicitName = entry;
      break;
    }
  }

  let inheritedUrl;
  let inheritedName;
  for (const entry of ["HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY"]) {
    const hit = snapshot.get(entry);
    const found = normalizeProxyUrl(hit?.value);
    if (found !== undefined) {
      inheritedUrl = found;
      inheritedName = entry;
      break;
    }
  }

  log(
    explicitUrl === undefined
      ? "discover: .env proxy -> (none)"
      : `discover: .env ${explicitName} -> ${explicitUrl}`
  );
  log(
    inheritedUrl === undefined
      ? "discover: inherited proxy env -> (none)"
      : `discover: inherited ${inheritedName} -> ${inheritedUrl} (only used as a last resort)`
  );

  const registryUrl = readWindowsSystemProxy(log);

  if (explicitUrl !== undefined) {
    proxyUrl = explicitUrl;
    source = `env-explicit:${explicitName}`;
  } else if (registryUrl !== undefined) {
    proxyUrl = registryUrl;
    source = "registry:ProxyServer";
  } else if (inheritedUrl !== undefined) {
    proxyUrl = inheritedUrl;
    source = `env-inherited:${inheritedName}`;
  }
  if (proxyUrl === undefined) {
    log("no proxy found; staying direct (nothing changed)");
    return;
  }

  // ---- 2) 配成 DSH 可用 ----
  const noProxy = snapshot.get("NO_PROXY")?.value ?? DEFAULT_NO_PROXY;
  const resolved = launchEnv.createLaunchEnvironmentSnapshot([
    {
      source: "process",
      values: {
        HTTP_PROXY: proxyUrl,
        HTTPS_PROXY: proxyUrl,
        ALL_PROXY: proxyUrl,
        NO_PROXY: noProxy
      }
    }
  ]);

  // 先清掉「从上一代进程继承来的」代理变量，再安装策略。
  // 为什么必须清（SC-0022 实测缺陷）：DSH 自带 dsh-http-proxy 的 proxyEnvironmentForChild()
  // 按 `inherited[name] !== undefined` 判断"用户在环境里设过它"，于是把**继承值**发给子进程，
  // 而不是本进程解析出的策略值。它分不清"用户设的"和"上一代泄漏进来的"。
  // 后果：代理软件换端口后，DSH 自己跟上了新端口，而 shell 子进程仍拿着已失效的旧端口
  // （实测：web_fetch 正常 200，而 node -e fetch → ECONNREFUSED）。
  // 清空之后，applyPolicyEnv() 内部快照这些名字为"未设置"，子进程就会拿到正确的解析值。
  // 注意：这不影响「人工覆盖」——.env 里显式写的值走的是启动快照 snapshot.getFrom(...)，
  // 该快照在进程启动时固化，与这里的 process.env 删除无关。
  for (const inheritedName of ["http_proxy", "HTTP_PROXY", "https_proxy", "HTTPS_PROXY", "all_proxy", "ALL_PROXY"]) {
    delete process.env[inheritedName];
  }

  const dispose = await httpProxy.installProxyFromEnvironment(resolved, (message) => log(`report: ${message}`));
  try {
    ctx.effect(() => dispose);
  } catch (error) {
    log(`effect registration failed (proxy stays active anyway): ${error?.message ?? String(error)}`);
  }
  log(`proxy installed: ${proxyUrl} (source=${source}, no_proxy=${noProxy})`);

  // ---- 3) 自检：不碰网络，只问 dispatcher 这条路会不会走代理 ----
  try {
    const route = httpProxy.proxyRouteFor(new URL("https://www.google.com/robots.txt"));
    log(`self-check proxyRouteFor(google).proxied=${route.proxied}`);
  } catch (error) {
    log(`FAIL self-check: ${error?.message ?? String(error)}`);
  }
}

export function apply(ctx) {
  const log = makeLogger(ctx);
  return activate(ctx, log).catch((error) => {
    log(`FAIL activate: ${error?.stack ?? error?.message ?? String(error)}`);
  });
}
