# ADR 0013：Agent App 必须打开并预填目录和提示词

**决定**：候选表里每一条 `kind: "app"` 都必须交付「打开 App + 工作目录 + 预填提示词、不自动发送」。新加品牌的 App 形态同一条。没有这条路径，就不要加 App 行。

**怎么做**：

1. **优先**官方一条深链，同时带目录和 prompt（Claude `claude://code/new?q=&folder=`，Codex `codex://new?prompt=&path=`）。
2. 官方把目录和 prompt 拆成两条通道（Cursor）：先打开目录，再发 prompt 深链（`deeplink.afterOpen`）。不把两条捏成一条假协议。
3. 深链失败才回落 `open -a` / `start exe` + 约定文件。
4. 命令必须在该平台真机验证过才把 `deeplink` 留在默认可用集。

**被拒的备选**：

- **只打开文件夹、不预填**：用户看到空 composer，交棒半成品。
- **没有官方协议也编一条**：未验证的 scheme 不能进表。
- **Terminal 也改成深链**：Terminal 已经把 prompt 注入 argv 并开跑，不是 App 体验条。

**下游**：`daemon/src/agents.ts` 两张候选表；`bun test` 守「每条 app 必须有 `deeplink.template`」。
