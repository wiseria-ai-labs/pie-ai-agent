# 远程 MCP server:扩展直连 Streamable HTTP,按 server 懒加载 + 会话内确认

issue #481。用户自己配置的远程 MCP server(Google Docs / Notion / Linear 等)由扩展
SW 直连,把 server 的工具交给 agent;与 daemon 侧还没实现的 stdio MCP 代理
(`~/.pie/mcp.json`,local-daemon-bridge spec Slice 3)是两条独立路径。

**决定**:

1. **落点**:最小手写 JSON-RPC 客户端跑在 SW 里(initialize → notifications/initialized
   → tools/list 分页 → tools/call),不引 `@modelcontextprotocol/sdk`——它的 client 用
   ajv 校验,走 `new Function`,被 manifest 的 `script-src 'self' 'wasm-unsafe-eval'`
   拒掉。JSON 与 SSE 两种响应都收;404 重 initialize 一次再重试。
   配置存 IDB `config` store 的 `mcp_servers`(header 值 AES-GCM 加密,同 API key),
   不用 chrome.storage。
2. **命名**:对外名 `mcp_<slug>_<tool>`,`[a-zA-Z0-9_-]` / ≤64 / 字母开头;slug 由用户
   填的名称派生(非 ASCII 回落到短 hash),保存时校验唯一,截断撞名加 hash 后缀。
   分发不靠名字:每个工具的 handler 闭包持有 {server, 原始工具名},名字永不反解析
   (对外名是有损的——净化与截断都不可逆)。
3. **披露粒度**:一个 server = 一个懒加载组 `mcp:<slug>`(progressive-tool-disclosure
   spec §9)。任务开始时按已配置 server 快照进 `<available_tools_catalog>` 与
   `load_tools` 的 enum(中途新增的 server 下个任务才可见,保持前缀字节稳定 #175)。
   未激活组的工具不进 tools 数组;server 下发的 `instructions` 与工具描述不进 system
   prompt(工具描述只能随 tools 数组走,属于「用户加了 server 就信任它」的既有边界)。
4. **确认(D1=A,ADR 0007 的默认)**:每个会话里第一次调用某 server 的工具弹一次
   HITL 卡(server 名 + 工具名 + args 原文),批准记进 session 持久状态,本会话内该
   server 不再弹,新会话重新确认。批准信号只走 panel-request,不进 tool schema,
   LLM 不能自批。headless(定时任务)run 完全不暴露 `mcp:*`。
5. **信任边界**:server 返回的文本(成功结果、JSON-RPC error、HTTP body)一律包进
   `<untrusted_mcp_result>` 并转义 wrapper 字面量;401/403 带出 HTTP 状态与 body,403
   附 Origin 放行提示(Pie 的 Origin 是 `chrome-extension://<扩展 ID>`)。server URL 的
   query/userinfo 与 header 值**永不**进模型可见文本、panel step 详情或 console 日志。
6. **共享握手**:连接按 server 缓存在 SW 内存、跨 session 共享;进行中的 initialize
   不绑任何 session 的 abort signal——abort 只取消该 session 自己的 tools/call。

**刻意不做**:stdio / 本地进程类 MCP、旧版 HTTP+SSE transport、MCP OAuth(只支持静态
header)、resources / prompts / sampling / elicitation / roots、server→client 请求、
GET 监听流、`notifications/tools/list_changed`、内置任何 server。
