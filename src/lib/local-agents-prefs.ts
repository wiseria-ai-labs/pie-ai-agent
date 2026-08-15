import { getConfig, setConfig } from "@/lib/idb/config-store";

// 设置页「本地 Agent」启用偏好。null（用户从没动过开关）= 已安装即启用（开箱
// 即用，"安装之后自动检测"）；一旦动过开关就落显式品牌 id 数组。
// 读时把旧形态 id（claude-app / claude-terminal）并集归一化成品牌 id。
const KEY = "enabled_local_agents";

export async function getEnabledLocalAgents(): Promise<string[] | null> {
  return (await getConfig<string[]>(KEY)) ?? null;
}

export async function setEnabledLocalAgents(ids: string[]): Promise<void> {
  await setConfig(KEY, ids);
}

/** 形态 id → 品牌 id：去掉末尾 `-(app|terminal)`。已经是品牌 id 的原样返回。 */
export function brandIdFromFormId(id: string): string {
  return id.replace(/-(app|terminal)$/, "");
}

/** 形态展示名 → 品牌展示名：剥掉 "(App)" / "(Terminal)" 尾缀。 */
export function brandLabelFromFormLabel(label: string): string {
  return label.replace(/\s*\((App|Terminal)\)\s*$/i, "").trim();
}

/** 形态 kind：优先用 daemon 给的字段，缺省从 id 后缀推断（旧 daemon）。 */
export function inferFormKind(
  id: string,
  kind?: "app" | "terminal",
): "app" | "terminal" | undefined {
  if (kind === "app" || kind === "terminal") return kind;
  if (id.endsWith("-app")) return "app";
  if (id.endsWith("-terminal")) return "terminal";
  // Slice 0 旧 wire 单项 "claude" = claude-terminal
  if (id === "claude") return "terminal";
  return undefined;
}

/** 读时归一化：null 保持「已装即启用」；旧形态 id 并集去重成品牌 id。 */
export function normalizeEnabledBrands(enabled: string[] | null): string[] | null {
  if (enabled == null) return null;
  return [...new Set(enabled.map(brandIdFromFormId))];
}

/** 单形态可用谓词 = 已安装 且 其品牌已启用（null 偏好 = 已安装全启用）。
 *  唯一真源：settings 列表的 enabled 标注（background/index.ts）与 handoff
 *  过滤（filterUsableAgents）都走这里，两处永不漂移。 */
export function isAgentUsable(
  a: { id: string; installed: boolean },
  enabled: string[] | null,
): boolean {
  const brands = normalizeEnabledBrands(enabled);
  return a.installed && (brands == null || brands.includes(brandIdFromFormId(a.id)));
}

/** handoff 卡片可用列表 = 已安装 ∩ 品牌已启用（null = 已安装全启用）。 */
export function filterUsableAgents<T extends { id: string; installed: boolean }>(
  detected: T[],
  enabled: string[] | null,
): T[] {
  return detected.filter((a) => isAgentUsable(a, enabled));
}

/** run_local_agent 卡片可选后端 = 已安装 ∩ 品牌已启用 ∩ 可作 headless 后端。
 *  daemon 权威的 `headless` 字段是唯一判据；旧 daemon 不给此字段 → 回落 kind === "terminal" 代理
 *  （候选表里 terminal ⟺ 有 headlessArgv）。daemon 侧还会再校验一次 target，卡片列表只是 UI 预筛。 */
export function filterHeadlessBackends<
  T extends { id: string; installed: boolean; kind?: "app" | "terminal"; headless?: boolean },
>(detected: T[], enabled: string[] | null): T[] {
  return detected.filter((a) => isAgentUsable(a, enabled) && (a.headless ?? a.kind === "terminal"));
}

/** 开关决策纯函数：id 是品牌 id。启用时现检测把关——该品牌一种形态都没装就拒；
 *  null 偏好先物化为「当前已装品牌全开」。写出的 next 恒为品牌 id。 */
export function applyToggle(
  detected: { id: string; installed: boolean }[],
  enabled: string[] | null,
  id: string,
  next: boolean,
): { ok: true; next: string[] } | { ok: false; reason: "not_installed" } {
  const brandId = brandIdFromFormId(id);
  const brandInstalled = detected.some((a) => a.installed && brandIdFromFormId(a.id) === brandId);
  if (next && !brandInstalled) {
    return { ok: false, reason: "not_installed" };
  }
  const installedBrands = [
    ...new Set(detected.filter((a) => a.installed).map((a) => brandIdFromFormId(a.id))),
  ];
  const base = normalizeEnabledBrands(enabled) ?? installedBrands;
  return { ok: true, next: next ? [...new Set([...base, brandId])] : base.filter((x) => x !== brandId) };
}

export interface AgentBrandGroup<T extends { id: string; label: string }> {
  id: string;
  label: string;
  forms: T[];
}

/** 按品牌分组，保留形态首次出现顺序（候选表已经是品牌分组、每组 App 在前）。 */
export function groupAgentsByBrand<T extends { id: string; label: string }>(
  agents: T[],
): AgentBrandGroup<T>[] {
  const order: string[] = [];
  const byBrand = new Map<string, T[]>();
  for (const a of agents) {
    const bid = brandIdFromFormId(a.id);
    let forms = byBrand.get(bid);
    if (!forms) {
      order.push(bid);
      forms = [];
      byBrand.set(bid, forms);
    }
    forms.push(a);
  }
  return order.map((id) => {
    const forms = byBrand.get(id)!;
    return { id, label: brandLabelFromFormLabel(forms[0].label), forms };
  });
}
