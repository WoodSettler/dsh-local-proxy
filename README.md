# dsh-local-proxy

A [DeepSeek Harness](https://github.com/deepseek-ai) (DSH) plugin that makes the agent's
network traffic use this machine's local HTTP proxy.

[中文说明见下](#中文说明)

## Why

DSH's CLI boot path calls `installProxyFromEnvironment()`, which turns proxy environment
variables into a process-wide dispatcher. The **DSH Desktop** boot path
(`resources/app/lib/host-process-entry.js` → `dsh-app-boot`'s `boot()`) does not, so on
Desktop the agent's own `web_fetch` tool always connects directly: a site behind a proxy
fails with `URL hostname "…" resolves to a non-public IP address`, while spawning `curl`
or `git` from the shell works fine because those read the variables themselves.

This plugin closes that gap.

## What it does

Two things only:

1. **Find the proxy** — the proxy environment variables DSH already resolved
   (`HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY`); if none are set, the Windows system proxy
   from `HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings`
   (`ProxyEnable` / `ProxyServer`, including the `http=host:port;https=host:port` form).
   Only loopback addresses are accepted.
2. **Make DSH use it** — installs the in-process dispatcher via DSH's own
   `installProxyFromEnvironment`, and publishes the proxy variables to child processes
   (plus `NODE_USE_ENV_PROXY=1` on Node ≥ 22.21/24).

## What it does NOT do

- It does not check whether the proxy works, whether the node is alive, or how fast it is.
  If your proxy is broken, fix your proxy.
- No port scanning, no PAC parsing, no TUN-mode handling, no non-Windows support.

## Behaviour on failure

Every step is wrapped: any error is logged and the plugin does nothing. It must never
break a direct connection that already worked.

Logs go to `<DSH_HOME>/dsh-local-proxy.log` (`DSH_HOME` defaults to `~/.dsh`).

## Install

```sh
# from a git repository
dsh plugin --profile desktop add github:<owner>/<repo>

# from npm
dsh plugin --profile desktop add dsh-local-proxy

# from a local checkout (run inside it)
dsh plugin --profile desktop add .
```

Then restart DSH. The CLI appends the package to `dsh.profile.bundles` automatically
because this package declares `dsh.bundle.patch`.

## Uninstall

```sh
dsh plugin --profile desktop remove dsh-local-proxy
```

Then remove the leftover log file and restart DSH.

---

## 中文说明

一个 DeepSeek Harness（DSH）插件：让 agent 的网络请求走本机的 HTTP 代理。

**为什么需要它**：DSH 的命令行启动路径会调用 `installProxyFromEnvironment()`，把代理环境变量
变成进程级的路由策略；而 **DSH 桌面版**的启动路径没有这一步，导致桌面版里 agent 自带的
`web_fetch` 工具始终直连——墙外站点会报 `resolves to a non-public IP address`，而从 shell 里
调 `curl` / `git` 却正常（因为它们自己读环境变量）。本插件补上这个缺口。

**只做两件事**：① 找代理（先看代理环境变量，没有就读 Windows 系统代理注册表，只接受回环地址）；
② 让 DSH 用上它（装进程内 dispatcher + 把代理变量发布给子进程）。

**不做什么**：不检测代理是否可用、不扫端口、不解析 PAC、不处理 TUN，也不支持非 Windows。

**失败时的行为**：任何一步出错都只记日志、什么都不做；绝不破坏原本可用的直连。

日志位置：`<DSH_HOME>/dsh-local-proxy.log`（`DSH_HOME` 默认是 `~/.dsh`）。
