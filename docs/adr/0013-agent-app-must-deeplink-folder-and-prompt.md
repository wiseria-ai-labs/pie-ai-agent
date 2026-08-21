# ADR 0013：Agent App 必须打开并预填目录和提示词

**决定**：候选表里每一条 `kind: "app"` 都必须交付「打开 App + 工作目录 + 预填提示词、不自动发送」。新加品牌的 App 形态同一条。没有这条路径，就不要加 App 行。

**怎么做**：

1. **优先**官方一条深链，同时带目录和 prompt（Claude `claude://code/new?q=&folder=`，Codex `codex://new?prompt=&path=`）。
2. 官方把目录和 prompt 拆成两条通道（Cursor）：先打开目录，再发 prompt 深链（`deeplink.afterOpen`）。不把两条捏成一条假协议。
3. 深链失败才回落 `open -a` / `start exe` + 约定文件。
4. 命令必须在该平台真机验证过才把 `deeplink` 留在默认可用集。

**例外（DeepSeek Harness，#41）**：官方产品主界面是本机 Web UI（`http://127.0.0.1:3080`），没有「打开 + 目录 + 预填 prompt」深链。允许这一条 `kind: "app"` 不带 `deeplink.template`，交棒改走 daemon 编排：

| ADR 0013 原文 | DSH 例外 |
| --- | --- |
| 官方一条深链，带目录 + 预填 prompt | 打开 `http://127.0.0.1:3080`（默认端口） |
| 预填 composer、不发送 | 不预填。交棒正文写入 `context.md`，并拷进系统剪贴板，用户自行粘贴发送 |
| 未验证 scheme 不准进表 | 允许 daemon 调本机 loopback 的内部 `POST /api/workspace.create`（无协议版本，真机验证；破了再跟） |

已开着的 Web UI 不会自动切到新 workspace（无 `workspace.select`）。用户要点一次 Choose workspace。产品接受。把 `dsh web` 当普通 App、不登记 workspace 的路径仍然否决。

其余 app 仍守原文：必须有 `deeplink.template`。

**被拒的备选**：

- **只打开文件夹、不预填**：用户看到空 composer，交棒半成品。
- **没有官方协议也编一条**：未验证的 scheme 不能进表（DSH 走 loopback HTTP，不是编一条 `dsh://`）。
- **Terminal 也改成深链**：Terminal 已经把 prompt 注入 argv 并开跑，不是 App 体验条。

**下游**：`daemon/src/agents.ts` 两张候选表（DSH App 挂 `webUi`，`runHandoff` 按有无该字段分发，不认品牌 id）；`bun test` 守「每条 app 必须有 `deeplink.template`，有 `webUi` 的除外」。
