# 模型输出图片（生图）功能设计 — 2026-06-02

## 1. 背景与目标

Pie 当前已支持图片**输入**（`vision`）：用户 attach 图片 → `ImageBlock` → 各 provider core 编码送给模型。本功能新增图片**输出**：让支持生图的模型（如 Gemini `gemini-2.5-flash-image` / "Nano Banana"）在对话中生成图片，渲染在 assistant 气泡里，并支持**多轮连续编辑**（"改蓝一点""加个帽子"）。

**范围边界（v1）：**
- 仅**图片**，不做视频（视频是异步 job→轮询的不同范式，留作未来）。
- 仅**纯聊天生图**场景：图片是 assistant 的终端输出，不作为 agent 工具链的中间产物。
- provider 解析：**Gemini native（主力）** + **OpenAI-compat/OpenRouter（共用 core，顺带支持）**；Anthropic 系不接（无原生 chat 流式生图）。

## 2. 关键技术事实（设计前提）

1. **生图必须在请求里显式声明 output modality**，否则模型只返回文本，且对非生图模型声明会报错：
   - Gemini：`generationConfig.responseModalities: ["TEXT","IMAGE"]`（不设默认只出文本）。
   - OpenRouter：请求 `modalities: ["image","text"]`，图片在 `choices[].message.images[].image_url.url`（data URL）返回。
   - 来源：[Gemini 图片生成文档](https://ai.google.dev/gemini-api/docs/image-generation)、[OpenRouter 图片生成文档](https://openrouter.ai/docs/guides/overview/multimodal/image-generation)
2. **因此"零配置自动出图"不成立**，必须有一个"该模型走生图模式"的信号 → capability flag。
3. **生图模型很可能不支持 function calling / tools**（官方文档未明确，实现期需实测）。因此生图模型整条不发 tools。

## 3. 集成策略：复用现有图片基础设施（方案 A）

复用而非新建。现有设施：
- `src/lib/images/types.ts`：`ImageAttachment`（带字节）/ `ImagePlaceholder`（剥字节、留 id）/ `ImageRef`（SW 缓存行）。
- `src/background/image-cache.ts`：per-session 内存缓存 + LRU 淘汰（总量 > 30MB 或 > 3 个带图 turn）。
- `src/lib/agent/image-hydration.ts`：发请求前把字节注水回上下文，placeholder 命中缓存则填回字节。

**唯一缺口**：上述只处理 user turn。生成图在 assistant turn → 需把缓存/注水延伸到 assistant turn。

## 4. 控制平面：capability flag + 触发 + tools 规则

### 4.1 `imageOutput` capability flag（与 `vision` 同构）

- `ModelMeta`（`src/lib/model-router/providers/registry.ts`）新增可选字段 `imageOutput?: boolean`。
- builtin registry：`gemini-2.5-flash-image` 预置 `imageOutput: true` 且 `vision: true`（图生图编辑需吃图输入）；OpenRouter 已知生图模型（`google/gemini-2.5-flash-image-preview`、flux 系）标注；其余默认 falsy。
- `StoredCustomModelMeta`（`src/lib/provider-custom-model-meta.ts`，`pcmm`）新增 `imageOutput: boolean`，在 `ModelMetaEditor` 加勾选项；`resolveModelMeta` 透出该字段。

### 4.2 触发与 tools 规则

| 激活模型 | tools | 输入框「生图」开关 | 请求 modality |
|---|---|---|---|
| `imageOutput: true` | **永不发** | 显示 | 开关 ON → 声明 IMAGE+TEXT；OFF → 仅 TEXT |
| `imageOutput: false` | 正常发（agent 行为不变） | 隐藏 | 不声明 |

- **tools 抑制绑定在 capability flag 上**（生图模型整条 chat-only），不绑在 per-message 开关——最稳，不赌生图模型 tools 兼容性。
- per-message 开关只控制本轮是否 IMAGE modality，默认 ON，状态在 compose 时记住。
- 开关仅当 active model `imageOutput` 时出现，挨着 attach 按钮。

## 5. 数据平面：类型扩展 + provider core + SW/port

### 5.1 StreamEvent 新增离散事件

图片整块到达，不做 byte-level 流式：
```ts
| { type: "image-output"; id: string; mediaType: "image/png" | "image/jpeg" | "image/webp"; data: string; width?: number; height?: number }
```
core 在某张生成图字节完整拼好后 emit 一次（Gemini inlineData 可能分块到达 → core 内累积，完成才 emit）。

### 5.2 ContentBlock：复用 `ImageBlock`

生成图复用现有 `ImageBlock`（`type:"image"`），放在 **assistant `AgentMessage`** 上。Gemini 原生支持 model-role inlineData part，多轮编辑时原样回送 assistant 历史即可，无需"把上一张图塞进 user turn"的 hack。

### 5.3 Provider core 改动

| Core | 请求侧（image turn） | 响应侧解析 | assistant 历史回送 |
|---|---|---|---|
| `gemini.ts`（native，主力） | 加 `generationConfig.responseModalities:["TEXT","IMAGE"]` | 解析 `parts[].inlineData{mimeType,data}` → emit `image-output` | assistant `ImageBlock` → model-role inlineData part（**编辑全链路原生支持**） |
| `openai-compat-core.ts`（含 OpenRouter） | 加 `modalities:["image","text"]` | 解析 `delta/message.images[].image_url.url` → emit `image-output` | OpenAI schema 不支持 assistant-role 图片 → **v1 编辑回送仅 best-effort**（标注限制，主力保证在 Gemini） |

### 5.4 SW loop 处理 `image-output`

`src/lib/agent/loop.ts` 收到事件时：
1. 写字节进 image-cache（session + assistant turn id）；
2. 通过 port 推 `generated-image` 消息给 panel 立即显示；
3. 在 assistant `AgentMessage` 记一个 `ImageBlock`（供历史/回送）；
4. 持久化走「placeholder + IndexedDB durable 字节」（见 §6）。

### 5.5 新增 port → panel 消息

```ts
| { type: "generated-image"; sessionId: string; turnId: string; id: string; mediaType: string; data: string; width?: number; height?: number }
```

## 6. 持久化（核心难点）

`chrome.storage.local` 默认 ~10MB，装不下多张 PNG。方案：
- 新增 manifest `unlimitedStorage` 权限。
- 新增 IndexedDB blob store（`generated-image-store`，仿 skill-store），按 image id 存生成图字节——**durable 显示源 + SW 重启后的编辑上下文源**。
- session 持久层（`chrome.storage.local` writeAtomic）assistant 消息只存 **placeholder + id**（剥字节），保持 session 文档小。
- SW 内存 `image-cache` 仍是编辑上下文快路径；扩展为接受 assistant turn 的 `ImageRef`，LRU 上限可上调。

## 7. 多轮编辑链路（hydration 延伸到 assistant turn）

- `hydrateAttachments` 当前只走 `m.role === "user"` → 扩展为也处理 assistant turn 的生成图 placeholder。
- 注水顺序：image-cache 命中 → 用内存字节；miss → 回 IndexedDB 读；都没有 → 留 placeholder（Gemini 收到无图 model turn 仍能工作，仅丢该图视觉上下文）。
- 跨刷新：cache 空 → 从 IndexedDB 重新注水 → 编辑仍成立；IndexedDB 也淘汰 → 气泡显示「该图已不可继续编辑」，按新生成处理。

## 8. UI 渲染（`src/sidepanel/components/Chat.tsx`）

- `DisplayMessage` assistant 变体加 `generatedImages?: {id,mediaType,width,height,data?}[]`（`data` 显示时从 IndexedDB 注水）。
- 生成中：占位骨架/「生成图片中…」；收到 `generated-image` port 消息 → 渲染图。
- 每张图 hover 出 **下载 / 复制** 按钮（复用 `downloads` 权限 / clipboard）。点击放大留后续。
- 输入区「生图」开关：仅当 active model `imageOutput` 时显示，挨着 attach 按钮。

## 9. 测试策略

- **单元**：
  - `imageOutput` 在 registry/pcmm 的解析与 round-trip；
  - image turn 时请求注入 `responseModalities`/`modalities`；
  - 生图模型 tools 被抑制；
  - gemini core 解析 `inlineData` → `image-output`；openai-compat 解析 `message.images` → `image-output`；
  - hydration 覆盖 assistant turn；LRU 淘汰。
- **跨层**：端到端 image turn → port 消息 + placeholder 持久化 + IndexedDB blob；Gemini 多轮编辑回送上一张图。
- **UI**：气泡渲染生成图 + 下载/复制；开关随 `imageOutput` 显隐。

## 10. 边界与错误

- 模型标了 imageOutput 但本轮没返回图（安全拦截/拒绝）→ 正常渲染文本说明，不报错。
- 生图请求失败（配额/限流）→ 气泡内错误态。
- 生成图计入 context token 预算（复用现有 `window-token-budget` 图片计费）。
- 安全内容：依赖 provider 自带审查，不额外过滤。

## 11. 未来扩展（明确不在 v1）

- 视频生成（Veo/Sora/Kling，异步 job→轮询范式）。
- agent 任务流程中生成图片并用于后续浏览器操作。
- 独立生图 endpoint（OpenAI gpt-image、智谱 CogView、MiniMax）—— 非 chat 流的另一套调用路径。
- OpenRouter 多轮编辑的完整回送（v1 仅 best-effort）。
- 生成图点击放大 / lightbox。
