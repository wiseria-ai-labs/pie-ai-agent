# 模型输出图片（生图）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让支持生图的模型（首发 Gemini `gemini-2.5-flash-image`，含 OpenRouter 路由）在纯聊天里生成图片，渲染在 assistant 气泡，并支持「编辑这张」多轮编辑。

**Architecture:** 新增 per-model `imageOutput` capability flag（复用 `vision`/`pcmm` 同构路径）。生图模型整条不发 tools；per-turn「生图」开关控制是否向请求声明 output modality（Gemini `responseModalities` / OpenAI-compat `modalities`）。core 解析响应里的图片字节 → 新 `image-output` StreamEvent → loop 经 port 推 `generated-image` 给 panel。**生成图归 panel 所有**（React state + IndexedDB durable），SW 对生成图无状态。多轮编辑由气泡里「编辑这张」按钮把目标图作为**新 user turn 的输入图**重发，复用现有输入图管线（Gemini/OpenRouter 通吃）。

**Tech Stack:** React 19 + TS 6, Vite 8 + @crxjs, vitest + happy-dom, chrome.storage.local + IndexedDB, MV3 service worker。

**Spec:** `docs/specs/2026-06-02-image-output-generation.md`

**全局约定（每个 task 通用）：**
- 测试框架 vitest，测试文件与源码同目录 `*.test.ts(x)`。
- 跑单测：`pnpm test src/path/to/file.test.ts`
- 每个 task 末尾 commit。提交信息用中文 + 结尾 `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`。
- 全部 task 完成后跑 `pnpm test`、`pnpm typecheck`、`pnpm build` 三连（提交前不变量）。

**共享类型（贯穿全 plan，命名锁定，勿改名）：**
- `ModelMeta.imageOutput?: boolean`（capability，registry.ts）
- `StoredCustomModelMeta.imageOutput?: boolean`（pcmm）
- `ModelConfig.imageOutput?: boolean`（capability，index.ts）+ `ModelConfig.imageOutputRequested?: boolean`（per-call 意图）
- `StreamEvent` 新成员 `{ type: "image-output"; id: string; mediaType: string; data: string; width?: number; height?: number }`
- 港口消息 `GeneratedImageMessage`（messages.ts）
- `GeneratedImage = { id: string; mediaType: string; width?: number; height?: number; data?: string }`（messages.ts，挂 DisplayMessage assistant 变体）

---

## Phase 1 — Capability flag 接线

### Task 1: `ModelMeta.imageOutput` + Gemini 生图模型预置

**Files:**
- Modify: `src/lib/model-router/providers/registry.ts:5-16`（ModelMeta）、`:118-127`（gemini models）
- Test: `src/lib/model-router/providers/registry.test.ts`（若不存在则新建）

- [ ] **Step 1: 写失败测试**

在 `src/lib/model-router/providers/registry.test.ts` 追加（无则新建并加 import）：
```ts
import { describe, it, expect } from "vitest";
import { getModelMeta } from "./registry";

describe("imageOutput capability", () => {
  it("gemini-2.5-flash-image is marked imageOutput + vision", () => {
    const m = getModelMeta("gemini", "gemini-2.5-flash-image");
    expect(m).toBeDefined();
    expect(m?.imageOutput).toBe(true);
    expect(m?.vision).toBe(true);
  });
  it("ordinary models have no imageOutput", () => {
    expect(getModelMeta("gemini", "gemini-2.5-pro")?.imageOutput).toBeUndefined();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/lib/model-router/providers/registry.test.ts`
Expected: FAIL（`gemini-2.5-flash-image` 未注册 → `m` undefined）

- [ ] **Step 3: 实现**

`registry.ts` ModelMeta 接口加字段（在 `maxContextTokens` 后）：
```ts
  /** Approximate context window for the token-budget guard. */
  maxContextTokens: number;
  /** Model can GENERATE images in chat (output modality). Drives the 生图 toggle + tools suppression. */
  imageOutput?: boolean;
```

`registry.ts` gemini provider `models` 数组加一项（放在现有两项后）：
```ts
    models: [
      { id: "gemini-2.0-flash", vision: true, tools: true, maxContextTokens: 1_000_000 },
      { id: "gemini-2.5-pro", vision: true, tools: true, maxContextTokens: 1_000_000 },
      { id: "gemini-2.5-flash-image", displayName: "gemini-2.5-flash-image (Nano Banana)", vision: true, tools: true, imageOutput: true, maxContextTokens: 32_768 },
    ],
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/lib/model-router/providers/registry.test.ts`
Expected: PASS

- [ ] **Step 5: commit**

```bash
git add src/lib/model-router/providers/registry.ts src/lib/model-router/providers/registry.test.ts
git commit -m "feat(model-meta): ModelMeta.imageOutput + gemini-2.5-flash-image 预置"
```

---

### Task 2: `pcmm` 存 `imageOutput` + `resolveModelMeta` 透出

**Files:**
- Modify: `src/lib/provider-custom-model-meta.ts:11-15`（StoredCustomModelMeta）
- Modify: `src/lib/model-router/providers/registry.ts:214-223`（resolveModelMeta pcmm 分支）
- Test: `src/lib/provider-custom-model-meta.test.ts`（若不存在则新建）、`registry.test.ts`

- [ ] **Step 1: 写失败测试**

`src/lib/provider-custom-model-meta.test.ts`（新建或追加）：
```ts
import { describe, it, expect, beforeEach } from "vitest";
import { setProviderCustomModelMeta, getProviderCustomModelMeta } from "./provider-custom-model-meta";

// happy-dom 不带 chrome；用最小 stub
beforeEach(() => {
  const store: Record<string, unknown> = {};
  (globalThis as any).chrome = {
    storage: { local: {
      get: async (k: string) => ({ [k]: store[k] }),
      set: async (o: Record<string, unknown>) => { Object.assign(store, o); },
    } },
  };
});

it("round-trips imageOutput", async () => {
  await setProviderCustomModelMeta("gemini", "my-img", { vision: true, imageOutput: true, maxContextTokens: 32000 });
  const r = await getProviderCustomModelMeta("gemini", "my-img");
  expect(r?.imageOutput).toBe(true);
});
```

`registry.test.ts` 追加（pcmm 落到 resolveModelMeta）：
```ts
import { resolveModelMeta } from "./registry";
it("resolveModelMeta surfaces pcmm imageOutput for builtin custom model", async () => {
  // 复用上面同款 chrome stub（若在独立文件，复制 beforeEach stub）
  const { setProviderCustomModelMeta } = await import("@/lib/provider-custom-model-meta");
  await setProviderCustomModelMeta("openrouter", "vendor/img-model", { vision: true, imageOutput: true, maxContextTokens: 32000 });
  const m = await resolveModelMeta("openrouter", "vendor/img-model");
  expect(m?.imageOutput).toBe(true);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/lib/provider-custom-model-meta.test.ts`
Expected: FAIL（`imageOutput` 不在类型/未透出）

- [ ] **Step 3: 实现**

`provider-custom-model-meta.ts` 接口加字段：
```ts
export interface StoredCustomModelMeta {
  displayName?: string;
  vision: boolean;
  /** Model can generate images (output modality). Absent on legacy records → false. */
  imageOutput?: boolean;
  maxContextTokens: number;
}
```

`registry.ts` resolveModelMeta 的 pcmm 分支（构造 ModelMeta 处）加透出：
```ts
    if (stored) {
      return {
        id: modelId,
        ...(stored.displayName ? { displayName: stored.displayName } : {}),
        vision: stored.vision,
        tools: true,
        maxContextTokens: stored.maxContextTokens,
        ...(stored.imageOutput ? { imageOutput: true } : {}),
      };
    }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/lib/provider-custom-model-meta.test.ts src/lib/model-router/providers/registry.test.ts`
Expected: PASS

- [ ] **Step 5: commit**

```bash
git add src/lib/provider-custom-model-meta.ts src/lib/model-router/providers/registry.ts src/lib/provider-custom-model-meta.test.ts src/lib/model-router/providers/registry.test.ts
git commit -m "feat(model-meta): pcmm 存 imageOutput + resolveModelMeta 透出"
```

---

### Task 3: `ModelMetaEditor` 加「图片输出」勾选

**Files:**
- Modify: `src/sidepanel/components/ModelMetaEditor.tsx:5-11`（Draft）、`:24-30`（初值）、`:89-96`（vision checkbox 后插入）
- Test: `src/sidepanel/components/ModelMetaEditor.test.tsx`

- [ ] **Step 1: 写失败测试**

`ModelMetaEditor.test.tsx` 追加：
```tsx
import { render, screen, fireEvent } from "@testing-library/react";
import ModelMetaEditor from "./ModelMetaEditor";

it("toggles imageOutput and returns it in draft", () => {
  const onSave = vi.fn();
  render(<ModelMetaEditor showTools={false} initial={{ id: "m1" }} onSave={onSave} onCancel={() => {}} />);
  fireEvent.click(screen.getByText(/advanced/i)); // 展开 advanced（按 i18n 实际文案调整匹配）
  fireEvent.click(screen.getByLabelText(/image output|图片输出/i));
  fireEvent.click(screen.getByText(/save|保存/i));
  expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ imageOutput: true }));
});
```
> 注：`getByText(/advanced/i)` 依赖 i18n key `customProvider.advanced` 的渲染文案；若测试环境 i18n 返回 key 本身，用 `screen.getByText("customProvider.advanced")`。先跑一次看实际渲染再定 matcher。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/sidepanel/components/ModelMetaEditor.test.tsx`
Expected: FAIL（无 imageOutput 勾选项）

- [ ] **Step 3: 实现**

`ModelMetaEditor.tsx`：

`ModelMetaDraft` 加字段：
```ts
export interface ModelMetaDraft {
  id: string;
  displayName?: string;
  vision: boolean;
  imageOutput: boolean;
  tools: boolean;
  maxContextTokens: number;
}
```

初值（useState 内）加：
```ts
    vision: initial?.vision ?? false,
    imageOutput: initial?.imageOutput ?? false,
    tools: initial?.tools ?? true,
```

vision 那个 `<label>` 之后插入 imageOutput 勾选（advancedOpen 块内）：
```tsx
            <label className="flex items-center gap-2 text-[12px] text-fg-1">
              <input
                type="checkbox"
                checked={draft.imageOutput}
                onChange={(e) => setDraft((prev) => ({ ...prev, imageOutput: e.target.checked }))}
              />
              {t("customProvider.imageOutput")}
            </label>
```

`ModelMetaDraft` 的 `initial?: Partial<ModelMetaDraft>` 已是 Partial，无需改 Props。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/sidepanel/components/ModelMetaEditor.test.tsx`
Expected: PASS

> i18n key `customProvider.imageOutput` 在 Task 19 统一补；此处先用 key，测试用正则兜底。

- [ ] **Step 5: commit**

```bash
git add src/sidepanel/components/ModelMetaEditor.tsx src/sidepanel/components/ModelMetaEditor.test.tsx
git commit -m "feat(settings): ModelMetaEditor 加图片输出勾选"
```

---

### Task 4: pcmm 写盘接线（InstanceForm / Settings / Wizard）+ ModelDropdown 保存

**Files:**
- Modify: 所有把 `ModelMetaDraft` 写进 `setProviderCustomModelMeta` 的调用点（grep 定位）
- Test: 对应已存在的接线测试文件

- [ ] **Step 1: 定位写盘点**

Run:
```bash
grep -rn "setProviderCustomModelMeta\|ModelMetaDraft\|StoredCustomModelMeta" src/sidepanel --include="*.tsx" --include="*.ts" | grep -v test
```
列出每个把 draft → StoredCustomModelMeta 的转换点（预计在 ModelDropdown / InstanceForm / SettingsView / Wizard）。

- [ ] **Step 2: 写失败测试**

在已有的相关测试（如 `ModelDropdown.test.tsx` 或 settings 接线测试）追加一条：保存一个勾了 imageOutput 的 draft 后，`setProviderCustomModelMeta` 收到 `imageOutput: true`。示例（按实际组件 API 调整）：
```tsx
it("persists imageOutput from editor draft", async () => {
  const spy = vi.spyOn(pcmm, "setProviderCustomModelMeta").mockResolvedValue();
  // ...渲染含 ModelMetaEditor 的容器，模拟保存 draft { id:"x", vision:true, imageOutput:true, tools:true, maxContextTokens:32000 }
  expect(spy).toHaveBeenCalledWith(expect.anything(), "x",
    expect.objectContaining({ imageOutput: true }));
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `pnpm test <对应测试文件>`
Expected: FAIL（draft.imageOutput 没被写进 StoredCustomModelMeta）

- [ ] **Step 4: 实现**

每个 `draft → StoredCustomModelMeta` 转换处，补 `imageOutput: draft.imageOutput`。典型形如：
```ts
await setProviderCustomModelMeta(provider, draft.id, {
  ...(draft.displayName ? { displayName: draft.displayName } : {}),
  vision: draft.vision,
  imageOutput: draft.imageOutput,
  maxContextTokens: draft.maxContextTokens,
});
```
若有读 StoredCustomModelMeta → 回填 editor initial 的地方，补 `imageOutput: stored.imageOutput ?? false`。

- [ ] **Step 5: 跑测试确认通过 + commit**

Run: `pnpm test <对应测试文件>`
Expected: PASS
```bash
git add -A
git commit -m "feat(settings): pcmm 写盘/回填带上 imageOutput"
```

---

## Phase 2 — ModelConfig + 请求声明 modality + tools 抑制

### Task 5: `ModelConfig.imageOutput` capability 解析

**Files:**
- Modify: `src/lib/model-router/index.ts:31-48`（ModelConfig）
- Modify: `src/lib/instances.ts:121-149`（resolveInstanceToModelConfig）
- Test: `src/lib/instances.test.ts`

- [ ] **Step 1: 写失败测试**

`instances.test.ts` 追加（按该文件已有的 instance/stub 套路）：
```ts
it("resolves imageOutput capability for gemini image model", async () => {
  // 造一个 provider=gemini, model=gemini-2.5-flash-image 的 instance（用文件里已有的 helper）
  const cfg = await resolveInstanceToModelConfig(idOfThatInstance);
  expect(cfg?.imageOutput).toBe(true);
});
it("non-image model has no imageOutput", async () => {
  const cfg = await resolveInstanceToModelConfig(idOfGemini25Pro);
  expect(cfg?.imageOutput).toBeUndefined();
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/lib/instances.test.ts`
Expected: FAIL（cfg.imageOutput 永远 undefined）

- [ ] **Step 3: 实现**

`model-router/index.ts` ModelConfig 加字段（`vision?` 后）：
```ts
  vision?: boolean;
  /** Model can generate images. Resolved at task start (capability). Drives tools suppression. */
  imageOutput?: boolean;
  /** Per-call: this turn should request image output modality. Set by the loop, not stored. */
  imageOutputRequested?: boolean;
```

`instances.ts` resolveInstanceToModelConfig 内，在 return 前补 imageOutput 解析（custom: 暂不支持，保持 false）：
```ts
  let imageOutput = false;
  if (!inst.provider.startsWith("custom:")) {
    imageOutput =
      resolveModelImageOutput(inst.provider as BuiltinProvider, inst.model, inst.fetchedModels) ??
      (await resolveModelMeta(inst.provider, inst.model))?.imageOutput ??
      false;
  }
  return {
    provider: inst.provider,
    providerName: meta.name,
    model: inst.model,
    apiKey: inst.apiKey,
    baseUrl: meta.defaultBaseUrl,
    ...(inst.maxTokens != null && { maxTokens: inst.maxTokens }),
    ...(vision !== undefined && { vision }),
    ...(imageOutput ? { imageOutput: true } : {}),
  };
```
`resolveModelImageOutput` 在 Task 6 实现；本 task 先在 instances.ts 顶部 import 它，并在 registry.ts 加一个最小实现（见下）。本 task 内先加 registry 的 `resolveModelImageOutput` stub-but-real：

`registry.ts` 追加（仿 `resolveModelVision`，放其后）：
```ts
export function resolveModelImageOutput(
  provider: BuiltinProvider,
  modelId: string,
  fetchedModels?: Pick<ModelMeta, "id" | "imageOutput">[],
): boolean | undefined {
  const registryHit = getModelMeta(provider, modelId);
  if (registryHit) return registryHit.imageOutput ?? false;
  const fetchedHit = fetchedModels?.find((m) => m.id === modelId);
  if (fetchedHit) return fetchedHit.imageOutput ?? false;
  return undefined;
}
```
`instances.ts` import：`import { resolveModelVision, resolveModelMeta, resolveModelImageOutput } from "@/lib/model-router/providers/registry";`（合并到已有 import）。
注：`inst.fetchedModels` 当前类型 `{ id; vision; tools; maxContextTokens }[]` 无 `imageOutput` —— 传入处用 `as` 收窄或在 Task 6 扩展该类型；本 task 让 `resolveModelImageOutput` 的 `fetchedModels` 形参用 `Pick<...,"id"|"imageOutput">` 容忍缺失（命中但无 imageOutput → false）。

- [ ] **Step 4: 跑测试确认通过 + commit**

Run: `pnpm test src/lib/instances.test.ts`
Expected: PASS
```bash
git add src/lib/model-router/index.ts src/lib/instances.ts src/lib/model-router/providers/registry.ts src/lib/instances.test.ts
git commit -m "feat(model-config): 解析 imageOutput capability 进 ModelConfig"
```

---

### Task 6: OpenRouter fetched 目录识别 imageOutput

**Files:**
- Modify: `src/lib/openrouter-models-fetch.ts`（normalizer）
- Modify: `src/lib/instances.ts:13`（fetchedModels 类型加 imageOutput）
- Test: `src/lib/openrouter-models-fetch.test.ts`

- [ ] **Step 1: 写失败测试**

`openrouter-models-fetch.test.ts` 追加（用该文件已有的 normalize 入口名；下例假设导出 `normalizeOpenRouterModels`）：
```ts
it("marks imageOutput when output_modalities includes image", () => {
  const out = normalizeOpenRouterModels({ data: [
    { id: "google/gemini-2.5-flash-image-preview",
      architecture: { input_modalities: ["text","image"], output_modalities: ["text","image"] },
      context_length: 32768 },
  ]} as any);
  expect(out[0].imageOutput).toBe(true);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/lib/openrouter-models-fetch.test.ts`
Expected: FAIL（normalizer 不产 imageOutput）

- [ ] **Step 3: 实现**

`openrouter-models-fetch.ts` 在构造每个 ModelMeta 处加：
```ts
imageOutput: Array.isArray(m.architecture?.output_modalities)
  && m.architecture.output_modalities.includes("image"),
```
（与现有 `vision` 取 `input_modalities.includes("image")` 对称。）

`instances.ts:13` 的 fetchedModels 类型补字段：
```ts
fetchedModels?: { id: string; vision: boolean; tools: boolean; maxContextTokens: number; imageOutput?: boolean }[];
```
若该形状在别处（如 `instances.ts` 的 StoredInstance / openrouter-models-fetch 的返回类型）有单独定义，一并补 `imageOutput?: boolean`。

- [ ] **Step 4: 跑测试确认通过 + commit**

Run: `pnpm test src/lib/openrouter-models-fetch.test.ts src/lib/instances.test.ts`
Expected: PASS
```bash
git add src/lib/openrouter-models-fetch.ts src/lib/instances.ts src/lib/openrouter-models-fetch.test.ts
git commit -m "feat(openrouter): fetched 目录按 output_modalities 识别 imageOutput"
```

---

### Task 7: `image-output` StreamEvent + 两个 core 请求侧声明 modality

**Files:**
- Modify: `src/lib/model-router/types.ts:52-65`（StreamEvent）
- Modify: `src/lib/model-router/providers/gemini.ts:81-87`（请求体 generationConfig）
- Modify: `src/lib/model-router/providers/_shared/openai-compat-core.ts:128-141`（requestBody）
- Test: `src/lib/model-router/providers/gemini.test.ts`、`.../openai-compat-core.test.ts`（或各 provider 测试）

- [ ] **Step 1: 写失败测试**

types：编译期即可（无需单测）。请求侧测试 —— gemini（断言 body 含 responseModalities）。在 `gemini.test.ts`（无则新建，用 `vi.stubGlobal("fetch", ...)` 截获 body）：
```ts
it("declares responseModalities when imageOutputRequested", async () => {
  let captured: any;
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    captured = JSON.parse(init.body as string);
    return new Response("", { status: 200 }); // 空流即可，仅校验请求体
  }));
  const { streamChat } = await import("./gemini");
  const gen = streamChat(
    { provider: "gemini", model: "gemini-2.5-flash-image", apiKey: "k", baseUrl: "https://x", imageOutputRequested: true } as any,
    [{ role: "user", content: "draw a cat" }],
  );
  for await (const _ of gen) { /* drain */ }
  expect(captured.generationConfig.responseModalities).toEqual(["TEXT", "IMAGE"]);
});
```
openai-compat 同理断言 `captured.modalities` 为 `["image","text"]`（用任一 OpenAI-compat provider wrapper 或直接测 `streamChatOpenAICompat`）。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/lib/model-router/providers/gemini.test.ts`
Expected: FAIL（无 responseModalities）

- [ ] **Step 3: 实现**

`types.ts` StreamEvent 在 `error` 前加成员：
```ts
  | { type: "image-output"; id: string; mediaType: string; data: string; width?: number; height?: number }
  | { type: "error"; error: string };
```

`gemini.ts` 请求体重构 generationConfig（替换原 `if (config.maxTokens != null) body.generationConfig = ...`）：
```ts
  const generationConfig: Record<string, unknown> = {};
  if (config.maxTokens != null) generationConfig.maxOutputTokens = config.maxTokens;
  if (config.imageOutputRequested) generationConfig.responseModalities = ["TEXT", "IMAGE"];
  if (Object.keys(generationConfig).length > 0) body.generationConfig = generationConfig;
```

`openai-compat-core.ts` requestBody 之后加：
```ts
  if (config.imageOutputRequested) requestBody.modalities = ["image", "text"];
```

- [ ] **Step 4: 跑测试确认通过 + commit**

Run: `pnpm test src/lib/model-router/providers/gemini.test.ts src/lib/model-router/providers/_shared/openai-compat-core.test.ts`
Expected: PASS
```bash
git add src/lib/model-router/types.ts src/lib/model-router/providers/gemini.ts src/lib/model-router/providers/_shared/openai-compat-core.ts src/lib/model-router/providers/gemini.test.ts src/lib/model-router/providers/_shared/openai-compat-core.test.ts
git commit -m "feat(model-router): image-output StreamEvent + 请求侧声明 output modality"
```

---

### Task 8: loop 对生图模型抑制 tools + 透传 imageOutputRequested

**Files:**
- Modify: `src/lib/agent/loop.ts:1460-1464`（tools 组装）、`:1487`（streamChat 调用）
- Modify: `src/lib/agent/loop.ts` AgentLoopContext（约 `:84` 处）加 `imageOutputRequested?: boolean`
- Test: `src/lib/agent/loop.test.ts`

- [ ] **Step 1: 写失败测试**

`loop.test.ts` 追加两条（用该文件已有的 runAgentLoop 驱动 + fake streamChat 套路；若已有 mock streamChat 的 helper 直接复用）：
```ts
it("suppresses tools when modelConfig.imageOutput is true", async () => {
  // 用 spy 捕获传给 streamChat 的 toolDefinitions（第 4 参）
  // 跑一个 imageOutput:true 的 modelConfig，断言 spy 收到 [] 长度 0
});
it("passes imageOutputRequested onto the streamChat config when ctx flag + capability both set", async () => {
  // 断言 streamChat 收到的 config.imageOutputRequested === true
});
```
> 实现细节按 `loop.test.ts` 既有 mock 风格写；关键断言是「toolDefinitions 为空」与「config.imageOutputRequested 透传」。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/lib/agent/loop.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

AgentLoopContext 接口加字段（紧邻 `modelConfig: ModelConfig;`）：
```ts
  modelConfig: ModelConfig;
  /** Per-turn 生图开关（panel→SW→loop）。仅当模型 imageOutput 能力存在时才有意义。 */
  imageOutputRequested?: boolean;
```

tools 组装（`loop.ts:1460-1464`）改为生图模型短路成空：
```ts
      const allTools = modelConfig.imageOutput === true
        ? []
        : filterToolsByVision(
            [...BUILT_IN_TOOLS, ...mouseTools, ...keyboardTools, requestLocalFileTool],
            modelConfig.vision,
          );
      const toolDefinitions = toolsToDefinitions(allTools);
```

streamChat 调用（`loop.ts:1487`）前构造 call config：
```ts
      const wantImageOutput = modelConfig.imageOutput === true && ctx.imageOutputRequested === true;
      const callConfig = wantImageOutput ? { ...modelConfig, imageOutputRequested: true } : modelConfig;
      for await (const event of streamChat(callConfig, windowedHistory, signal, toolDefinitions)) {
```

- [ ] **Step 4: 跑测试确认通过 + commit**

Run: `pnpm test src/lib/agent/loop.test.ts`
Expected: PASS
```bash
git add src/lib/agent/loop.ts src/lib/agent/loop.test.ts
git commit -m "feat(loop): 生图模型抑制 tools + 透传 imageOutputRequested"
```

---

## Phase 3 — 响应解析 → image-output 事件

### Task 9: Gemini core 解析 `inlineData` → image-output

**Files:**
- Modify: `src/lib/model-router/providers/gemini.ts:5-10`（GeminiPart）、`:116-139`（解析循环）
- Test: `src/lib/model-router/providers/gemini.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
it("emits image-output from candidate inlineData", async () => {
  const sse = [
    `data: ${JSON.stringify({ candidates: [{ content: { parts: [
      { text: "here you go" },
      { inlineData: { mimeType: "image/png", data: "AAAA" } },
    ] } }] })}\n\n`,
    `data: ${JSON.stringify({ candidates: [{ finishReason: "STOP" }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2 } })}\n\n`,
  ].join("");
  vi.stubGlobal("fetch", vi.fn(async () =>
    new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } })));
  const { streamChat } = await import("./gemini");
  const events: any[] = [];
  for await (const e of streamChat({ provider: "gemini", model: "gemini-2.5-flash-image", apiKey: "k", baseUrl: "https://x" } as any, [{ role: "user", content: "draw" }])) events.push(e);
  const img = events.find((e) => e.type === "image-output");
  expect(img).toMatchObject({ mediaType: "image/png", data: "AAAA" });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/lib/model-router/providers/gemini.test.ts`
Expected: FAIL（inlineData 被忽略）

- [ ] **Step 3: 实现**

`gemini.ts` GeminiPart 接口加响应侧字段（camelCase，区别于请求侧 snake `inline_data`）：
```ts
interface GeminiPart {
  text?: string;
  inline_data?: { mime_type: string; data: string };
  inlineData?: { mimeType: string; data: string };
  functionCall?: { name: string; args: Record<string, unknown> };
  functionResponse?: { name: string; response: { content: string } };
}
```

解析循环（`streamChat` 内，`let toolCallIndex = 0;` 旁加 `let imageIndex = 0;`），在 parts 循环里 `p.functionCall` 分支后加：
```ts
          } else if (p.inlineData?.data) {
            yield { type: "image-output", id: `gemini_img_${imageIndex++}`, mediaType: p.inlineData.mimeType, data: p.inlineData.data };
          }
```
> 假设：Gemini 单张图的 `inlineData` 在单个 SSE chunk 内完整到达（v1 不做跨 chunk 拼接；若实测分片再补累积）。

- [ ] **Step 4: 跑测试确认通过 + commit**

Run: `pnpm test src/lib/model-router/providers/gemini.test.ts`
Expected: PASS
```bash
git add src/lib/model-router/providers/gemini.ts src/lib/model-router/providers/gemini.test.ts
git commit -m "feat(gemini): 解析响应 inlineData → image-output 事件"
```

---

### Task 10: OpenAI-compat core 解析 `images` → image-output

**Files:**
- Modify: `src/lib/model-router/providers/_shared/openai-compat-core.ts:172-176`（loop 前加计数器）、`:210-252`（chunk 解析）
- Test: `src/lib/model-router/providers/_shared/openai-compat-core.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
it("emits image-output from delta.images data URL", async () => {
  const sse = [
    `data: ${JSON.stringify({ choices: [{ delta: { images: [
      { type: "image_url", image_url: { url: "data:image/png;base64,BBBB" } },
    ] } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`,
    `data: [DONE]\n\n`,
  ].join("");
  vi.stubGlobal("fetch", vi.fn(async () =>
    new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } })));
  const { streamChatOpenAICompat } = await import("./openai-compat-core");
  const events: any[] = [];
  for await (const e of streamChatOpenAICompat({ provider: "openrouter", model: "x", apiKey: "k", baseUrl: "https://x/api" } as any, [{ role: "user", content: "draw" }])) events.push(e);
  expect(events.find((e) => e.type === "image-output")).toMatchObject({ mediaType: "image/png", data: "BBBB" });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/lib/model-router/providers/_shared/openai-compat-core.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

`openai-compat-core.ts`，在 `let thinkingOpen = false;` 旁加 `let imageIndex = 0;`。

chunk 解析里（`const delta = choice.delta;` 之后、`tool_calls` 处理附近）加：
```ts
        const imgs = (delta?.images ?? choice.message?.images) as Array<{ image_url?: { url?: string } }> | undefined;
        if (Array.isArray(imgs)) {
          for (const im of imgs) {
            const url = im?.image_url?.url ?? "";
            const m = url.match(/^data:([^;]+);base64,(.*)$/);
            if (m) yield { type: "image-output", id: `oai_img_${imageIndex++}`, mediaType: m[1], data: m[2] };
          }
        }
```

- [ ] **Step 4: 跑测试确认通过 + commit**

Run: `pnpm test src/lib/model-router/providers/_shared/openai-compat-core.test.ts`
Expected: PASS
```bash
git add src/lib/model-router/providers/_shared/openai-compat-core.ts src/lib/model-router/providers/_shared/openai-compat-core.test.ts
git commit -m "feat(openai-compat): 解析 message/delta.images → image-output 事件"
```

---

## Phase 4 — SW→panel 转发 + chat-start 开关透传

### Task 11: `GeneratedImageMessage` port 类型 + `ChatStartMessage.imageOutput` + `GeneratedImage`

**Files:**
- Modify: `src/types/messages.ts`（新接口 + PortMessageToPanel 并集 + ChatStartMessage + DisplayMessage assistant 变体）
- Test: 编译期 + `src/types/messages.test.ts`（若有；否则靠下游 task 测）

- [ ] **Step 1: 实现类型（无独立单测，靠 typecheck + 下游）**

`messages.ts` 加：
```ts
/** 一张模型生成图。`data` 内存态有、落 chrome.storage 前剥离、显示时从 IndexedDB 水合。 */
export interface GeneratedImage {
  id: string;
  mediaType: string;
  width?: number;
  height?: number;
  data?: string;
}

/** SW → Panel：模型生成的一张图（与 chat-chunk 并行）。 */
export interface GeneratedImageMessage {
  type: "generated-image";
  sessionId: string;
  id: string;
  mediaType: string;
  data: string;
  width?: number;
  height?: number;
}
```

`PortMessageToPanel` 并集加成员：`| GeneratedImageMessage`。

`ChatStartMessage`（找到该接口定义）加可选字段：
```ts
  /** Per-turn 生图开关（仅生图模型有意义；透传给 loop）。 */
  imageOutput?: boolean;
```

`DisplayMessage` assistant 变体（`messages.ts:215`）：
```ts
  | { role: "assistant"; content: string; thinking?: string; generatedImages?: GeneratedImage[] }
```

- [ ] **Step 2: typecheck**

Run: `pnpm typecheck`
Expected: 0 错（新类型自洽；下游未接也不报错，字段都可选）

- [ ] **Step 3: commit**

```bash
git add src/types/messages.ts
git commit -m "feat(types): GeneratedImageMessage/GeneratedImage + ChatStart.imageOutput + DisplayMessage.generatedImages"
```

---

### Task 12: loop 把 image-output 经 port 推 `generated-image`

**Files:**
- Modify: `src/lib/agent/loop.ts:1487-1557`（事件 if 链加分支）
- Test: `src/lib/agent/loop.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
it("forwards image-output as a generated-image port message", async () => {
  // fake streamChat 产出一个 image-output 事件 + done
  // 断言 port.postMessage 收到 { type:"generated-image", id, mediaType, data, sessionId }
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/lib/agent/loop.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

事件 if 链（`else if (event.type === "done")` 之前）加：
```ts
        } else if (event.type === "image-output") {
          port.postMessage(withSession({
            type: "generated-image",
            id: event.id,
            mediaType: event.mediaType,
            data: event.data,
            ...(event.width != null ? { width: event.width } : {}),
            ...(event.height != null ? { height: event.height } : {}),
          }, sessionId));
```

- [ ] **Step 4: 跑测试确认通过 + commit**

Run: `pnpm test src/lib/agent/loop.test.ts`
Expected: PASS
```bash
git add src/lib/agent/loop.ts src/lib/agent/loop.test.ts
git commit -m "feat(loop): image-output → generated-image port 消息"
```

---

### Task 13: chat-start 透传 `imageOutput` → handleChatStream → ctx

**Files:**
- Modify: `src/background/index.ts:1315-1330`（chat-start 处理）、`handleChatStream` 签名与 runAgentLoop 调用（约 `:986-1205`）
- Test: `src/background/index.test.ts`（若存在）或 `src/__tests__/cross-layer/*`

- [ ] **Step 1: 写失败测试**

在 background 或 cross-layer 测试加：发 `chat-start { imageOutput: true }` → `runAgentLoop` 收到 `ctx.imageOutputRequested === true`。若 background 难单测，放到 Task 20 的 cross-layer e2e 一并验证，本 task 仅做实现 + typecheck。

- [ ] **Step 2: 实现**

`background/index.ts` chat-start 分支把 `message.imageOutput` 传入 handleChatStream：
```ts
      handleChatStream(
        port,
        message.messages,
        message.sessionId,
        abortRotation.current,
        inFlightSessionIds,
        keepAlive,
        message.imageOutput === true,   // NEW
      );
```
`handleChatStream` 签名加形参 `imageOutputRequested: boolean = false`，并在其内 `runAgentLoop({ ... })` 调用里补：
```ts
    await runAgentLoop({
      // ...existing
      modelConfig,
      imageOutputRequested,   // NEW
      // ...
    });
```

- [ ] **Step 3: typecheck + commit**

Run: `pnpm typecheck`
Expected: 0 错
```bash
git add src/background/index.ts
git commit -m "feat(sw): chat-start.imageOutput 透传至 runAgentLoop ctx"
```

---

## Phase 5 — Panel 显示 + 持久化（IndexedDB）

### Task 14: IndexedDB generated-image store

**Files:**
- Create: `src/lib/images/generated-image-store.ts`
- Test: `src/lib/images/generated-image-store.test.ts`

- [ ] **Step 1: 写失败测试**

`generated-image-store.test.ts`（happy-dom 自带 indexedDB；vitest 环境 jsdom/happy-dom 需 fake-indexeddb，按仓库现有 skill-store 测试方式；若 skill-store 无测试则引入 `fake-indexeddb/auto`）：
```ts
import "fake-indexeddb/auto";
import { describe, it, expect } from "vitest";
import { putGeneratedImage, getGeneratedImage, deleteGeneratedImage } from "./generated-image-store";

describe("generated-image-store", () => {
  it("put/get/delete round-trip", async () => {
    await putGeneratedImage({ id: "g1", mediaType: "image/png", data: "AAAA", width: 10, height: 20 });
    const r = await getGeneratedImage("g1");
    expect(r).toMatchObject({ id: "g1", mediaType: "image/png", data: "AAAA" });
    await deleteGeneratedImage("g1");
    expect(await getGeneratedImage("g1")).toBeNull();
  });
});
```
> 若 `fake-indexeddb` 不是依赖，先 `pnpm add -D fake-indexeddb`，并确认 vitest 环境（happy-dom 自带 IDB 实现亦可，二选一）。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/lib/images/generated-image-store.test.ts`
Expected: FAIL（文件不存在）

- [ ] **Step 3: 实现**

`src/lib/images/generated-image-store.ts`（仿 `skill-store.ts` 结构）：
```ts
export interface GeneratedImageRecord {
  id: string;
  mediaType: string;
  data: string; // base64
  width?: number;
  height?: number;
}

const DB_NAME = "pie-generated-images";
const STORE = "images";
const DB_VERSION = 1;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const req = fn(t.objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        t.oncomplete = () => db.close();
      }),
  );
}

export async function putGeneratedImage(rec: GeneratedImageRecord): Promise<void> {
  await tx("readwrite", (s) => s.put(rec));
}
export async function getGeneratedImage(id: string): Promise<GeneratedImageRecord | null> {
  const r = await tx<GeneratedImageRecord | undefined>("readonly", (s) => s.get(id));
  return r ?? null;
}
export async function deleteGeneratedImage(id: string): Promise<void> {
  await tx<undefined>("readwrite", (s) => s.delete(id));
}
```

- [ ] **Step 4: 跑测试确认通过 + commit**

Run: `pnpm test src/lib/images/generated-image-store.test.ts`
Expected: PASS
```bash
git add src/lib/images/generated-image-store.ts src/lib/images/generated-image-store.test.ts package.json pnpm-lock.yaml
git commit -m "feat(images): IndexedDB generated-image store"
```

---

### Task 15: slot 累积 + port-handlers 处理 generated-image，折进 assistant

**Files:**
- Modify: `src/sidepanel/hooks/useSession/runtime-map.ts:14-45`（slot 形状 + 初值）
- Modify: `src/sidepanel/hooks/useSession/port-handlers.ts:70-117`（buildAssistant + handler）
- Test: `src/sidepanel/hooks/useSession/port-handlers.test.ts`

- [ ] **Step 1: 写失败测试**

`port-handlers.test.ts` 追加：
```ts
it("accumulates generated-image and folds into assistant on chat-done", () => {
  // setup deps（复用文件里 helper）
  handleMessage({ type: "generated-image", sessionId: "s1", id: "g1", mediaType: "image/png", data: "AAAA" });
  handleMessage({ type: "chat-chunk", sessionId: "s1", text: "done" });
  handleMessage({ type: "chat-done", sessionId: "s1" });
  const msgs = slotsRef.current.get("s1")!.messages;
  const last = msgs[msgs.length - 1] as any;
  expect(last.role).toBe("assistant");
  expect(last.generatedImages).toEqual([{ id: "g1", mediaType: "image/png", data: "AAAA" }]);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/sidepanel/hooks/useSession/port-handlers.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

`runtime-map.ts` slot 形状加 `streamingImages: GeneratedImage[]`（import GeneratedImage from `@/types/messages`），初值 `streamingImages: []`。所有重置 streaming 缓冲的地方（与 `streamingText: ""` 同处）补 `streamingImages: []`。

`port-handlers.ts`：

`buildAssistant` 加参 + 带出 generatedImages：
```ts
  const buildAssistant = (
    base: DisplayMessage[],
    accumulated: string,
    thinking: string,
    images: GeneratedImage[],
  ): { next: DisplayMessage[]; flushed: boolean } => {
    if (!accumulated.trim() && !thinking.trim() && images.length === 0) return { next: base, flushed: false };
    const m: DisplayMessage = {
      role: "assistant",
      content: accumulated,
      ...(thinking.trim() ? { thinking } : {}),
      ...(images.length ? { generatedImages: images } : {}),
    };
    return { next: [...base, m], flushed: true };
  };
```

handler 加 generated-image 分支（在 thinking-chunk 后）：
```ts
    if (msg.type === "generated-image") {
      void putGeneratedImage({ id: msg.id, mediaType: msg.mediaType, data: msg.data, ...(msg.width!=null?{width:msg.width}:{}), ...(msg.height!=null?{height:msg.height}:{}) });
      patchSlot(id, (prev) => ({
        streamingImages: [...prev.streamingImages, { id: msg.id, mediaType: msg.mediaType, data: msg.data, ...(msg.width!=null?{width:msg.width}:{}), ...(msg.height!=null?{height:msg.height}:{}) }],
      }));
      return;
    }
```
（import `putGeneratedImage` from `@/lib/images/generated-image-store`、`GeneratedImage` from `@/types/messages`。）

chat-done 分支取 images 并传入 buildAssistant，清空 streamingImages：
```ts
    if (msg.type === "chat-done") {
      const prev = slotsRef.current.get(id);
      const accumulated = prev?.accumulated ?? "";
      const thinking = prev?.streamingThinking ?? "";
      const images = prev?.streamingImages ?? [];
      const baseMessages = prev?.messages ?? [];
      const { next } = buildAssistant(baseMessages, accumulated, thinking, images);
      patchSlot(id, {
        messages: next,
        accumulated: "",
        streamingThinking: "",
        streamingText: "",
        streamingImages: [],
        streaming: false,
        streamFinished: true,
      });
      void persistMessages(id, next);
      return;
    }
```
注：`persistMessages` 落盘前的字节剥离在 Task 16 处理。

- [ ] **Step 4: 跑测试确认通过 + commit**

Run: `pnpm test src/sidepanel/hooks/useSession/port-handlers.test.ts`
Expected: PASS
```bash
git add src/sidepanel/hooks/useSession/runtime-map.ts src/sidepanel/hooks/useSession/port-handlers.ts src/sidepanel/hooks/useSession/port-handlers.test.ts
git commit -m "feat(panel): 累积 generated-image 并折进 assistant DisplayMessage"
```

---

### Task 16: 落盘剥字节 + 读盘水合（IndexedDB）

**Files:**
- Modify: 持久化点 `persistMessages`/`persistMessagesById`（`useSession/index.ts:304-325`）
- Modify: 会话读取点（`useSession/index.ts` 把 storage messages 灌进 slot 处，约 `:565` / `:912`）
- Test: `src/sidepanel/hooks/useSession/index.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
it("strips generatedImages bytes before persisting, keeps metadata", async () => {
  // 调 persistMessagesById(id, [{role:"assistant", content:"x", generatedImages:[{id:"g1",mediaType:"image/png",data:"AAAA"}]}])
  // 断言写进 storage 的 message.generatedImages[0].data === undefined，但 id/mediaType 在
});
it("hydrates generatedImages data from IndexedDB on load", async () => {
  // putGeneratedImage g1; 读盘后 slot.messages 的 generatedImages[0].data === "AAAA"
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/sidepanel/hooks/useSession/index.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

加一个纯函数（放 `useSession` 下新文件 `generated-image-hydration.ts`，便于单测复用）：
```ts
import type { DisplayMessage, GeneratedImage } from "@/types/messages";
import { getGeneratedImage } from "@/lib/images/generated-image-store";

/** 落盘前：assistant.generatedImages 剥 data（字节进 IndexedDB，已在 port-handler put 过）。 */
export function stripGeneratedImageBytes(messages: DisplayMessage[]): DisplayMessage[] {
  return messages.map((m) => {
    if (m.role !== "assistant" || !m.generatedImages?.length) return m;
    return { ...m, generatedImages: m.generatedImages.map(({ data: _d, ...rest }) => rest as GeneratedImage) };
  });
}

/** 读盘后：把缺 data 的 generatedImages 从 IndexedDB 水合（显示/编辑用）。 */
export async function hydrateGeneratedImageBytes(messages: DisplayMessage[]): Promise<DisplayMessage[]> {
  return Promise.all(messages.map(async (m) => {
    if (m.role !== "assistant" || !m.generatedImages?.length) return m;
    const imgs = await Promise.all(m.generatedImages.map(async (g) => {
      if (g.data) return g;
      const rec = await getGeneratedImage(g.id);
      return rec ? { ...g, data: rec.data } : g;
    }));
    return { ...m, generatedImages: imgs };
  }));
}
```

`persistMessages`/`persistMessagesById` 写盘前对 messages 跑 `stripGeneratedImageBytes`。

会话读取灌 slot 处（设置 `messages: remote` / `metaForActivate.messages` 前）跑 `await hydrateGeneratedImageBytes(...)`。

- [ ] **Step 4: 跑测试确认通过 + commit**

Run: `pnpm test src/sidepanel/hooks/useSession/index.test.ts src/sidepanel/hooks/useSession/generated-image-hydration.test.ts`
Expected: PASS（顺手为 hydration 纯函数写独立单测文件）
```bash
git add src/sidepanel/hooks/useSession/index.ts src/sidepanel/hooks/useSession/generated-image-hydration.ts src/sidepanel/hooks/useSession/generated-image-hydration.test.ts src/sidepanel/hooks/useSession/index.test.ts
git commit -m "feat(panel): 生成图落盘剥字节 + 读盘从 IndexedDB 水合"
```

---

### Task 17: 气泡渲染生成图 + 下载/复制

**Files:**
- Modify: `src/sidepanel/components/Chat.tsx:1628-1643`（assistant 气泡）、`:1187-1190`（streaming 气泡传 generatedImages）
- Test: `src/sidepanel/components/Chat.test.tsx`

- [ ] **Step 1: 写失败测试**

```tsx
it("renders generated images in assistant bubble", () => {
  render(<MessageBubble message={{ role: "assistant", content: "ok", generatedImages: [{ id: "g1", mediaType: "image/png", data: "AAAA" }] }} />);
  const img = screen.getByRole("img");
  expect(img).toHaveAttribute("src", "data:image/png;base64,AAAA");
});
```
> 若 `MessageBubble` 非导出，测试改为渲染整个 Chat 或为该子组件加 `export`。沿用 Chat.test.tsx 既有渲染策略。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/sidepanel/components/Chat.test.tsx`
Expected: FAIL

- [ ] **Step 3: 实现**

assistant 气泡 `MarkdownContent` 之后加生成图渲染：
```tsx
      {message.content && (
        <div className="text-[13px] leading-5 text-fg-1">
          <MarkdownContent content={message.content} />
        </div>
      )}
      {message.generatedImages?.map((g) =>
        g.data ? (
          <GeneratedImageView key={g.id} image={g} onEdit={onEditImage} />
        ) : (
          <span key={g.id} className="inline-block self-start rounded border border-line bg-field px-2 py-0.5 font-mono text-[11px] text-fg-3">
            {t("chat.generatedImage.released")}
          </span>
        ),
      )}
```

新增 `GeneratedImageView` 子组件（同文件内，下载 + 复制 + 编辑这张占位 onEdit 在 Task 18 接）：
```tsx
function GeneratedImageView({ image, onEdit }: { image: GeneratedImage; onEdit?: (img: GeneratedImage) => void }) {
  const t = useT();
  const src = `data:${image.mediaType};base64,${image.data}`;
  const download = () => {
    const a = document.createElement("a");
    a.href = src; a.download = `generated-${image.id}.${image.mediaType.split("/")[1] ?? "png"}`;
    a.click();
  };
  const copy = async () => {
    const blob = await (await fetch(src)).blob();
    await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
  };
  return (
    <div className="group relative inline-block self-start">
      <img src={src} alt={t("chat.generatedImage.alt")} className="block max-w-[260px] rounded" />
      <div className="absolute right-1 top-1 hidden gap-1 group-hover:flex">
        <button type="button" onClick={download} title={t("common.download")} className="rounded bg-black/60 px-1.5 py-0.5 text-[10px] text-white">{t("common.download")}</button>
        <button type="button" onClick={copy} title={t("common.copy")} className="rounded bg-black/60 px-1.5 py-0.5 text-[10px] text-white">{t("common.copy")}</button>
        {onEdit && <button type="button" onClick={() => onEdit(image)} title={t("chat.generatedImage.edit")} className="rounded bg-black/60 px-1.5 py-0.5 text-[10px] text-white">{t("chat.generatedImage.edit")}</button>}
      </div>
    </div>
  );
}
```

streaming 气泡（`Chat.tsx:1187-1190`）传 `generatedImages={streamingImages}`（streamingImages 从 useSession 暴露；若未暴露，在 useSession 返回值补 `streamingImages` 字段，仿 streamingText）。MessageBubble 的 message 类型用 `Extract<DisplayMessage,{role:"user"|"assistant"}>` 已含 generatedImages。`onEditImage` 在 Task 18 接，本 task 先可传 undefined。

- [ ] **Step 4: 跑测试确认通过 + commit**

Run: `pnpm test src/sidepanel/components/Chat.test.tsx`
Expected: PASS（i18n key 在 Task 19 补，测试用正则/key 兜底）
```bash
git add src/sidepanel/components/Chat.tsx src/sidepanel/components/Chat.test.tsx
git commit -m "feat(chat): assistant 气泡渲染生成图 + 下载/复制"
```

---

## Phase 6 — 编辑这张 + 生图开关 + manifest/i18n

### Task 18: 「编辑这张」→ 暂存为 composer 输入附件

**Files:**
- Modify: `src/sidepanel/components/Chat.tsx`（onEditImage handler + 传入 MessageBubble；自动开启生图开关）
- Test: `src/sidepanel/components/Chat.test.tsx`

- [ ] **Step 1: 写失败测试**

```tsx
it("staging an image to edit adds it to attachments and enables image toggle", async () => {
  // 渲染 Chat，注入一条带 generatedImages 的 assistant 消息
  // 点击该图的「编辑这张」
  // 断言 composer 出现一个图片附件（attachments 状态含该图 base64）+ imageOutput 开关为 on
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/sidepanel/components/Chat.test.tsx`
Expected: FAIL

- [ ] **Step 3: 实现**

Chat.tsx 加 handler（把生成图转成 `ImageAttachment` 塞进 `attachments`，并开启生图开关）：
```ts
  const onEditImage = useCallback((img: GeneratedImage) => {
    if (!img.data) return;
    const mediaType = (img.mediaType as ImageAttachment["mediaType"]) ?? "image/png";
    setAttachments((prev) => [...prev, {
      kind: "image", id: `edit-${img.id}`, data: img.data!, mediaType,
      width: img.width ?? 0, height: img.height ?? 0,
      byteLength: Math.ceil((img.data!.length * 3) / 4),
    }]);
    setImageOutputOn(true); // Task 19 的开关 state
  }, []);
```
把 `onEditImage` 透传到渲染历史消息的 `MessageBubble`（给 assistant 消息）。
> `imageOutputOn` state 在 Task 19 引入；本 task 与 Task 19 顺序耦合 —— 实现时若先做本 task，先加 `const [imageOutputOn, setImageOutputOn] = useState(false);` 占位，Task 19 复用。

- [ ] **Step 4: 跑测试确认通过 + commit**

Run: `pnpm test src/sidepanel/components/Chat.test.tsx`
Expected: PASS
```bash
git add src/sidepanel/components/Chat.tsx src/sidepanel/components/Chat.test.tsx
git commit -m "feat(chat): 编辑这张 → 暂存生成图为输入附件"
```

---

### Task 19: 「生图」开关（按 imageOutput 显隐）+ 透传 chat-start

**Files:**
- Modify: `src/sidepanel/components/chat-vision.ts`（加 `resolveSupportsImageOutput`）
- Modify: `src/sidepanel/components/Chat.tsx`（开关 state/UI + vision-gate effect 里解析 imageOutput + 发送时带 imageOutput）
- Modify: `src/sidepanel/hooks/useSession/index.ts:578-665`（SendMessageInput.imageOutput → chat-start）
- Test: `src/sidepanel/components/chat-vision.test.ts`、`Chat.test.tsx`、`useSession/index.test.ts`

- [ ] **Step 1: 写失败测试**

`chat-vision.test.ts`：
```ts
it("resolveSupportsImageOutput true for gemini image model", async () => {
  expect(await resolveSupportsImageOutput("gemini", "gemini-2.5-flash-image")).toBe(true);
  expect(await resolveSupportsImageOutput("gemini", "gemini-2.5-pro")).toBe(false);
});
```
`useSession/index.test.ts`：
```ts
it("chat-start carries imageOutput when input.imageOutput is true", async () => {
  // sendMessage({ content:"draw", imageOutput:true }) → 断言 postWithReconnect 收到的 chat-start.imageOutput === true
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/sidepanel/components/chat-vision.test.ts src/sidepanel/hooks/useSession/index.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

`chat-vision.ts` 加（仿 `resolveSupportsVision`，用 `resolveModelImageOutput` + `resolveModelMeta` 兜底）：
```ts
import { resolveModelVision, resolveModelMeta, resolveModelImageOutput } from "@/lib/model-router/providers/registry";

export async function resolveSupportsImageOutput(
  provider: ProviderRef,
  model: string,
  fetchedModels?: ModelMeta[],
): Promise<boolean> {
  const reg = provider.startsWith("custom:")
    ? undefined
    : resolveModelImageOutput(provider as BuiltinProvider, model, fetchedModels);
  if (reg !== undefined) return reg;
  return (await resolveModelMeta(provider, model))?.imageOutput ?? false;
}
```

`Chat.tsx`：
- vision-gate effect（`:538-557`）里多 set 一个 `supportsImageOutput`：`setSupportsImageOutput(await resolveSupportsImageOutput(inst.provider, inst.model, inst.fetchedModels));`
- 加 state：`const [supportsImageOutput, setSupportsImageOutput] = useState(false);`（`imageOutputOn` 已在 Task 18 加）
- 输入区 attach 按钮旁渲染「生图」开关：仅 `supportsImageOutput` 时显示，绑 `imageOutputOn`：
```tsx
{supportsImageOutput && (
  <button type="button" aria-pressed={imageOutputOn}
    onClick={() => setImageOutputOn((v) => !v)}
    title={t("chat.imageOutput.toggle")}
    className={`... ${imageOutputOn ? "text-accent" : "text-fg-3"}`}>
    {t("chat.imageOutput.toggle")}
  </button>
)}
```
- 发送处（`sendMessage`/`handleSubmit` 调 `sessionSendMessage`/`addPendingInstruction` 时）带上 `imageOutput: imageOutputOn`，发送后 `setImageOutputOn(false)` 复位（编辑这张会再次打开）。

`useSession/index.ts`：`SendMessageInput` 加 `imageOutput?: boolean`；`sendMessage` 的 `postWithReconnect(id, { type:"chat-start", messages, sessionId, ...(input.imageOutput ? { imageOutput: true } : {}) })`。

`messages.ts` 的 `ChatStartMessage` 已在 Task 11 加 `imageOutput?`。

**新增 i18n keys**（在 `src/lib/i18n` 的 zh + en 资源里补，本 task 一并加）：
- `customProvider.imageOutput`（中:「图片输出」/ en:"Image output"）
- `chat.imageOutput.toggle`（「生图」/"Generate image"）
- `chat.generatedImage.alt`（「生成的图片」/"Generated image"）
- `chat.generatedImage.edit`（「编辑这张」/"Edit this"）
- `chat.generatedImage.released`（「图已释放」/"Image released"）
- `common.download` / `common.copy`（若已存在则复用）

- [ ] **Step 4: 跑测试确认通过 + commit**

Run: `pnpm test src/sidepanel/components/chat-vision.test.ts src/sidepanel/components/Chat.test.tsx src/sidepanel/hooks/useSession/index.test.ts`
Expected: PASS
```bash
git add -A
git commit -m "feat(chat): 生图开关随 imageOutput 显隐 + 透传 chat-start + i18n"
```

---

### Task 20: manifest `unlimitedStorage`

**Files:**
- Modify: `manifest.json`（permissions）
- Test: `src/__tests__/`（若有 manifest 不变量测试）或人工

- [ ] **Step 1: 实现**

`manifest.json` permissions 数组加 `"unlimitedStorage"`：
```json
  "permissions": ["activeTab", "sidePanel", "storage", "unlimitedStorage", "tabs", "tabGroups", "scripting", "debugger", "webNavigation", "offscreen", "downloads"],
```

- [ ] **Step 2: 验证 build 不变量**

Run: `pnpm build`
Expected: 构建通过（manifest invariant 不校验 permissions 列表，仅校验 service_worker/version；通过即可）

- [ ] **Step 3: commit**

```bash
git add manifest.json
git commit -m "feat(manifest): 加 unlimitedStorage 权限（生成图 IndexedDB durable）"
```

---

## Phase 7 — 端到端 + 文档

### Task 21: 跨层 e2e 测试

**Files:**
- Create: `src/__tests__/cross-layer/image-output.test.ts`

- [ ] **Step 1: 写测试**

覆盖整链：fake 一个产 `image-output` 的 streamChat → runAgentLoop（imageOutput model + imageOutputRequested=true）→ 断言：
1. tools 为空传给 streamChat；
2. callConfig.imageOutputRequested === true；
3. port 收到 `generated-image`；
4. （panel 侧）handleMessage 链把它折进 assistant DisplayMessage 的 generatedImages。
参考 `src/__tests__/cross-layer/` 既有写法组织。

- [ ] **Step 2: 跑测试**

Run: `pnpm test src/__tests__/cross-layer/image-output.test.ts`
Expected: PASS

- [ ] **Step 3: commit**

```bash
git add src/__tests__/cross-layer/image-output.test.ts
git commit -m "test(cross-layer): 生图端到端链路"
```

---

### Task 22: 文档 + CLAUDE.md 不变量 + README

**Files:**
- Modify: `pie-ai-agent/CLAUDE.md`（Architecture Invariants 加一条生图说明）
- Modify: `README.md` + `README.zh-CN.md`（features 列表加「图片生成」）
- Create: `docs/solutions/`（可选 trace 文档）

- [ ] **Step 1: 实现**

- CLAUDE.md 在 Provider/capability 段补：`imageOutput` per-model flag（registry 预置 + pcmm + OpenRouter output_modalities 识别）；生图模型整条不发 tools；生成图归 panel 所有（IndexedDB `generated-image-store`），SW 无状态；编辑走「编辑这张」→ user 输入图重发。
- README 中英双份各自语言同步加一句生图能力（注意 [[pie-dual-readme-sync]]：两份分别用对应语言）。

- [ ] **Step 2: commit**

```bash
git add pie-ai-agent/CLAUDE.md README.md README.zh-CN.md docs/solutions
git commit -m "docs: 记录生图功能架构不变量 + README 双语同步"
```

---

## 收尾：全量验证

- [ ] `pnpm test`（全绿）
- [ ] `pnpm typecheck`（0 错）
- [ ] `pnpm build`（manifest 不变量通过）
- [ ] 人工冒烟：加载 dist，选 `gemini-2.5-flash-image` instance（真实 key）→「生图」开关出现 → 发「画一只猫」→ 气泡出图 → 点「编辑这张」+「加顶帽子」→ 出编辑后的图 → 刷新 side panel → 图仍显示（IndexedDB 水合）。

---

## Self-Review 记录（plan 作者自查）

- **Spec 覆盖**：§4 capability→Task 1-6；§4.2 tools 抑制+开关→Task 8/19；§5 类型/请求/解析→Task 7/9/10；§5.4-5.5 port→Task 11/12；§6 IndexedDB 持久化→Task 14/16；§7 编辑这张→Task 18；§8 UI→Task 17/19；§9 测试散落各 task + Task 21；§10 边界（无图正常渲染/失败错误态）由现有 text-delta/error 路径覆盖，生成图缺失走 released 占位（Task 17）。
- **类型一致性**：`imageOutput`（ModelMeta/StoredCustomModelMeta/ModelConfig）、`imageOutputRequested`（ModelConfig/ctx）、`image-output`（StreamEvent）、`generated-image`（port）、`GeneratedImage`（DisplayMessage）、`GeneratedImageRecord`（IndexedDB）—— 命名贯穿一致。
- **顺序耦合提示**：Task 18 与 Task 19 共用 `imageOutputOn` state（建议先做 19 再做 18，或在 18 内占位）；Task 5 先落 `resolveModelImageOutput` 最小实现，Task 6 再扩 OpenRouter 目录字段。
- **已知假设**：Gemini `inlineData` 单 chunk 完整到达（Task 9）；生图模型 tools 不支持→整条抑制（Task 8，实测若支持可放宽）。
