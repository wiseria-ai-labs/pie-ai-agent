/**
 * 记忆 S0 验证实验（spec §5.7 第 1、2 项）——可重复跑。
 *
 * 1) 延迟：在「16k token 索引 + 关 thinking」下实测 deepseek-flash 的选择器
 *    p50 / p95。软超时 2.5s、硬超时 4s 能不能装下，看这里的数字。
 * 2) 质量：30 对「任务 → 应选记忆」标注（可用 --pairs=100 扩到 100 对），
 *    比较「LLM 选 8 条」与「随机 8 条」的命中率。明显不优于随机就不做挑选层。
 *
 * 跑法：
 *   set -a; source ~/.pie/acceptance.env; set +a
 *   pnpm tsx eval/memory/s0-memory-retrieval.ts
 *   pnpm tsx eval/memory/s0-memory-retrieval.ts --pairs=100 --runs=30
 *
 * 凭据：PIE_EVAL_API_KEY（provider 必须是 deepseek）。本脚本**不打印、不写入**
 * key；报告里只出现 provider / model / 数字。
 */

import fs from "node:fs";
import path from "node:path";
import {
  buildMemoryIndexLines,
  buildMemorySelectorUserPrompt,
  MEMORY_SELECTOR_SYSTEM_PROMPT,
} from "../../src/lib/memory/prompt";
import { MEMORY_KINDS, type MemoryEntry } from "../../src/lib/memory/types";

// ── 参数 ────────────────────────────────────────────────────────────────────
const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k!, v ?? "true"] as const;
  }),
);
const RUNS = Number(args.get("runs") ?? 20);
const PAIRS = Math.min(100, Number(args.get("pairs") ?? 30));
// 索引条数。spec 的挑选预算是「≤500 条 ≈ 16k token」，调研文档的上限是 800 条；
// 默认按 500 条（产品上限）跑，--index=800 可测上限档。
const INDEX_SIZE = Number(args.get("index") ?? 500);

const PROVIDER = process.env.PIE_EVAL_PROVIDER ?? "";
const API_KEY = process.env.PIE_EVAL_API_KEY ?? "";
// spec §5.5：开发期固定 deepseek-flash。允许 --model 覆盖，但会写进报告。
const MODEL = args.get("model") ?? "deepseek-flash";
const BASE_URL = process.env.PIE_EVAL_BASE_URL ?? "https://api.deepseek.com";

if (PROVIDER !== "deepseek") {
  console.error(`[s0] PIE_EVAL_PROVIDER 必须是 deepseek（当前 "${PROVIDER}"）。先 set -a; source ~/.pie/acceptance.env; set +a`);
  process.exit(2);
}
if (!API_KEY) {
  console.error("[s0] PIE_EVAL_API_KEY 为空——先 source ~/.pie/acceptance.env。");
  process.exit(2);
}

// ── 极简 CJK 感知 token 估算（与 src/lib/agent/window-token-budget.ts 同口径）──
function estimateTokens(text: string): number {
  const cjk = (text.match(/[一-鿿぀-ヿ㐀-䶿가-힯]/g) ?? []).length;
  const ratio = text.length > 0 ? cjk / text.length : 0;
  return Math.ceil(text.length / (ratio > 0.5 ? 1.5 : 4));
}

// ── 造数据 ──────────────────────────────────────────────────────────────────
const TOPICS = [
  ["高铁", "出行", "偏好上午出发、靠窗、一等座"],
  ["咖啡", "饮食", "每天上午一杯美式，不加糖"],
  ["邮件", "工作", "中文、简洁、不用口头语"],
  ["代码", "工作", "TypeScript + pnpm，写测试"],
  ["健身", "生活", "周三周五晚上练背和腿"],
  ["住址", "联系", "杭州市西湖区文三路"],
  ["手机", "联系", "13800000000，工作号"],
  ["航班", "出行", "靠过道，提前 2 小时到机场"],
  ["酒店", "出行", "要高楼层、安静、含早"],
  ["报销", "工作", "月底统一提交发票"],
  ["会议", "工作", "周一下午排周会，30 分钟"],
  ["牙医", "健康", "半年洗一次牙，在市口腔"],
  ["宠物", "生活", "一只三岁柯基，叫豆豆"],
  ["买菜", "生活", "山姆会员店，两周一次"],
  ["记账", "财务", "用手机记账 App，按周看"],
  ["英语", "学习", "看英文文章先要中文要点"],
  ["写作", "工作", "先列大纲再写，不用感叹号"],
  ["旅行", "生活", "每年两次长途，偏好日本"],
  ["车", "生活", "周末洗车，加 95 号油"],
  ["房租", "财务", "每月 5 号交，走银行转账"],
  ["孩子", "家庭", "小学三年级，周三有奥数"],
  ["医院", "健康", "浙一医院，挂号用 App"],
  ["网购", "生活", "京东自营优先，次日达"],
  ["阅读", "学习", "每天睡前半小时纸质书"],
  ["摄影", "爱好", "喜欢 35mm 定焦，扫街"],
  ["游泳", "健康", "周日早上去游泳馆"],
  ["银行", "财务", "招商银行工资卡"],
  ["快递", "生活", "放门口快递柜，不打电话"],
  ["外卖", "生活", "少辣、不要香菜"],
  ["会议记录", "工作", "会后当天发纪要给参会人"],
] as const;

function makeEntry(i: number, idPrefix = "m_f"): MemoryEntry {
  const [a, b, c] = TOPICS[i % TOPICS.length]!;
  const suffix = i >= TOPICS.length ? ` #${Math.floor(i / TOPICS.length)}` : "";
  return {
    id: `${idPrefix}${String(i).padStart(4, "0")}`,
    kind: MEMORY_KINDS[i % MEMORY_KINDS.length]!,
    title: `${a}：${c}${suffix}`,
    body: `${b} 类记忆，长期稳定${suffix}`,
    tags: [a, b],
    createdAt: Date.UTC(2026, 9, 1),
    updatedAt: Date.UTC(2026, 10, 1) - i * 3600_000,
    validFrom: Date.UTC(2026, 9, 1),
    useCount: i % 5,
    origin: "consolidated",
  };
}

// 30 条「目标记忆」+ 填充，组成 INDEX_SIZE 条索引。
const targets: MemoryEntry[] = TOPICS.map(([a, , c], i) => ({
  ...makeEntry(i, "m_t"),
  id: `m_t${String(i).padStart(2, "0")}`,
  title: `${a}：${c}`,
  tags: [a],
}));
const fillers: MemoryEntry[] = Array.from({ length: Math.max(0, INDEX_SIZE - targets.length) }, (_, i) =>
  makeEntry(i),
);
const store: MemoryEntry[] = [...targets, ...fillers];

// 30 对标注（任务 → 应选记忆）。--pairs>30 时用模板生成到 100 对。
type Pair = { task: string; expected: string; pageTitle?: string };
const CURATED: Pair[] = [
  { task: "帮我订周三去上海的高铁", expected: "m_t00" },
  { task: "下午想喝咖啡，帮我点一杯", expected: "m_t01" },
  { task: "把这封回复邮件改写一下", expected: "m_t02" },
  { task: "帮我初始化一个前端项目", expected: "m_t03" },
  { task: "今晚健身房练什么？", expected: "m_t04" },
  { task: "我家的收货地址是哪个", expected: "m_t05" },
  { task: "填一下这个表单里的手机号", expected: "m_t06" },
  { task: "订明天去北京的机票", expected: "m_t07" },
  { task: "帮我订一家酒店", expected: "m_t08" },
  { task: "这个月的发票怎么报", expected: "m_t09" },
  { task: "约一个团队会议", expected: "m_t10" },
  { task: "该洗牙了吗", expected: "m_t11" },
  { task: "豆豆的狗粮没了", expected: "m_t12" },
  { task: "周末去山姆买点东西", expected: "m_t13" },
  { task: "看看我记账 App 里这周花了多少", expected: "m_t14" },
  { task: "帮我读这篇英文文章", expected: "m_t15" },
  { task: "写一份产品周报", expected: "m_t16" },
  { task: "暑假带孩子去日本玩，查查行程", expected: "m_t17" },
  { task: "周末要洗车吗", expected: "m_t18" },
  { task: "房租什么时候交", expected: "m_t19" },
  { task: "孩子的奥数课在周几", expected: "m_t20" },
  { task: "帮我挂个号", expected: "m_t21" },
  { task: "在京东买个充电器", expected: "m_t22" },
  { task: "推荐一本睡前读物", expected: "m_t23" },
  { task: "这个镜头适合扫街吗", expected: "m_t24" },
  { task: "周日早上有什么安排", expected: "m_t25" },
  { task: "工资卡是哪家银行", expected: "m_t26" },
  { task: "快递到了吗", expected: "m_t27" },
  { task: "点个外卖，别放香菜", expected: "m_t28" },
  { task: "开完会要做什么", expected: "m_t29" },
];

function buildPairs(n: number): Pair[] {
  const out = CURATED.slice(0, n);
  const verbs = ["帮我查一下", "看看", "安排一下", "记住要", "关于"];
  let i = 0;
  while (out.length < n && i < 500) {
    const t = targets[i % targets.length]!;
    const verb = verbs[i % verbs.length]!;
    out.push({
      task: `${verb}${t.title.replace("：", " 的 ")}`,
      expected: t.id,
    });
    i++;
  }
  return out;
}

// ── DeepSeek Anthropic 兼容端点 ─────────────────────────────────────────────
interface Timing {
  firstTokenMs: number;
  totalMs: number;
  text: string;
  inputTokens?: number;
}

async function callSelector(userPrompt: string): Promise<Timing> {
  const started = performance.now();
  const res = await fetch(`${BASE_URL}/anthropic/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 200,
      stream: true,
      system: MEMORY_SELECTOR_SYSTEM_PROMPT,
      messages: [{ role: "user", content: userPrompt }],
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok || !res.body) {
    throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  let firstTokenMs = -1;
  let text = "";
  let inputTokens: number | undefined;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        const ev = JSON.parse(payload) as {
          type?: string;
          message?: {
            usage?: { input_tokens?: number; cache_read_input_tokens?: number };
          };
          delta?: { type?: string; text?: string };
        };
        if (ev.type === "message_start" && ev.message?.usage) {
          // 权威口径：provider 报的 prompt tokens。DeepSeek 的 Anthropic 端点会把
          // 命中前缀缓存的 token 单列在 cache_read_input_tokens 里 —— 两者相加才是
          // 这次挑选真实读进去的索引大小。
          const u = ev.message.usage;
          const total = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
          if (total > 0) inputTokens = total;
        }
        if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") {
          if (firstTokenMs < 0) firstTokenMs = performance.now() - started;
          text += ev.delta.text ?? "";
        }
      } catch {
        /* 非 JSON 行（event: / ping）忽略 */
      }
    }
  }
  return { firstTokenMs: firstTokenMs < 0 ? performance.now() - started : firstTokenMs, totalMs: performance.now() - started, text, inputTokens };
}

function parseIds(raw: string): string[] {
  const out: string[] = [];
  for (const m of raw.matchAll(/\bm_[0-9a-zA-Z-]+/g)) {
    const id = m[0]!;
    if (!out.includes(id)) out.push(id);
    if (out.length >= 8) break;
  }
  return out;
}

function percentile(xs: number[], p: number): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)]!;
}

// ── 跑 ──────────────────────────────────────────────────────────────────────
const indexLines = buildMemoryIndexLines(store);
const basePrompt = buildMemorySelectorUserPrompt({
  task: "（延迟测试）帮我看下这周要做的事",
  pageTitle: "新标签页",
  pageUrl: "chrome://newtab",
  profileText: "用户在杭州，做产品相关工作，偏好简洁的中文回答。",
  indexLines,
});
const indexTokens = estimateTokens(indexLines);
console.log(`[s0] provider=${PROVIDER} model=${MODEL} index=${store.length} 条 / ${indexLines.length} 字符 / ≈${indexTokens} tokens（估算，真实值看下面 API 报的 input_tokens）`);

async function runLatency() {
  const timings: Timing[] = [];
  for (let i = 0; i < RUNS; i++) {
    const prompt = i === 0 ? basePrompt : basePrompt.replace("这周要做的事", `这周要做的事（第 ${i + 1} 次）`);
    try {
      const t = await callSelector(prompt);
      timings.push(t);
      process.stdout.write(
        `  run ${i + 1}/${RUNS}: ttft ${t.firstTokenMs.toFixed(0)}ms · total ${t.totalMs.toFixed(0)}ms` +
          `${t.inputTokens ? ` · input ${t.inputTokens} tokens` : ""}\n`,
      );
    } catch (e) {
      console.error(`  run ${i + 1}/${RUNS} failed: ${(e as Error).message}`);
    }
  }
  const ttft = timings.map((t) => t.firstTokenMs);
  const total = timings.map((t) => t.totalMs);
  const inputTokens = timings.map((t) => t.inputTokens ?? 0).filter((n) => n > 0);
  return {
    runs: timings.length,
    ttftP50: percentile(ttft, 50),
    ttftP95: percentile(ttft, 95),
    totalP50: percentile(total, 50),
    totalP95: percentile(total, 95),
    inputTokens: inputTokens.length > 0 ? Math.max(...inputTokens) : undefined,
    overSoft: total.filter((x) => x > 2_500).length,
    overHard: total.filter((x) => x > 4_000).length,
  };
}

async function runQuality() {
  const pairs = buildPairs(PAIRS);
  const known = new Set(store.map((e) => e.id));
  let llmHits = 0;
  let randomExpected = 0;
  const misses: string[] = [];
  for (const [i, p] of pairs.entries()) {
    const prompt = buildMemorySelectorUserPrompt({
      task: p.task,
      pageTitle: p.pageTitle ?? "新标签页",
      pageUrl: "chrome://newtab",
      profileText: "用户在杭州，做产品相关工作，偏好简洁的中文回答。",
      indexLines,
    });
    try {
      const { text } = await callSelector(prompt);
      const ids = parseIds(text).filter((id) => known.has(id));
      if (ids.includes(p.expected)) llmHits++;
      else misses.push(`${p.task} → 期望 ${p.expected}，实际 [${ids.join(", ") || "空"}]`);
      process.stdout.write(`  pair ${i + 1}/${pairs.length}: ${ids.includes(p.expected) ? "hit" : "miss"}\n`);
    } catch (e) {
      misses.push(`${p.task} → 调用失败 ${(e as Error).message}`);
      process.stdout.write(`  pair ${i + 1}/${pairs.length}: error\n`);
    }
    // 随机基线：从整库随机抽 8 条命中的概率（解析解）。
    randomExpected += Math.min(8, store.length) / store.length;
  }
  return {
    pairs: pairs.length,
    llmHitRate: llmHits / pairs.length,
    randomHitRate: randomExpected / pairs.length,
    misses,
  };
}

const latency = await runLatency();
console.log(`[s0] 延迟：ttft p50=${latency.ttftP50.toFixed(0)}ms p95=${latency.ttftP95.toFixed(0)}ms · ` +
  `total p50=${latency.totalP50.toFixed(0)}ms p95=${latency.totalP95.toFixed(0)}ms · ` +
  `超软超时 ${latency.overSoft}/${latency.runs} · 超硬超时 ${latency.overHard}/${latency.runs}`);

const quality = await runQuality();
console.log(`[s0] 质量：${quality.pairs} 对 · LLM 命中 ${(quality.llmHitRate * 100).toFixed(1)}% · ` +
  `随机 8 条基线 ${(quality.randomHitRate * 100).toFixed(1)}%`);

const verdict =
  latency.totalP95 <= 4_000 && quality.llmHitRate >= quality.randomHitRate + 0.2
    ? "GO —— 4s 硬超时内能返回，且挑选明显优于随机"
    : latency.totalP95 > 4_000
      ? "NO-GO（延迟）—— p95 超过硬超时，挑选会常态退化成只带画像"
      : "NO-GO（质量）—— 挑选不明显优于随机，按 spec 只保留画像";

const report = `# 记忆 S0 验证结果（${new Date().toISOString().slice(0, 10)}）

- provider: \`${PROVIDER}\` · model: \`${MODEL}\` · thinking: 未开启（请求不带 thinking）
- 索引：${store.length} 条 / ${indexLines.length} 字符 / ≈${indexTokens} tokens（CJK 感知估算）${
  latency.inputTokens ? ` · API 实测 input_tokens=${latency.inputTokens}` : ""
}
- 软超时 2.5s · 硬超时 4s（spec §5.5）

## 延迟（${latency.runs} 次）

| 指标 | p50 | p95 |
|---|---|---|
| 首 token | ${latency.ttftP50.toFixed(0)} ms | ${latency.ttftP95.toFixed(0)} ms |
| 完整返回 | ${latency.totalP50.toFixed(0)} ms | ${latency.totalP95.toFixed(0)} ms |

超过软超时 ${latency.overSoft}/${latency.runs} 次，超过硬超时 ${latency.overHard}/${latency.runs} 次。

## 挑选质量（${quality.pairs} 对标注）

| 策略 | 命中率（期望条目落在选出的 8 条内） |
|---|---|
| LLM 挑选 | ${(quality.llmHitRate * 100).toFixed(1)}% |
| 随机 8 条（解析解） | ${(quality.randomHitRate * 100).toFixed(1)}% |

${quality.misses.length > 0 ? `未命中：\n${quality.misses.slice(0, 10).map((m) => `- ${m}`).join("\n")}\n` : ""}
> 注：填充条目按 29 个主题循环生成，部分「未命中」是选到了与目标同主题的填充条目
> （语义等价，真实库里不会有这种重复）。所以上面的命中率是**保守下限**。

## 结论

**${verdict}**
`;

const outDir = path.join(import.meta.dirname, "results");
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, `s0-${new Date().toISOString().slice(0, 10)}-index${store.length}.md`);
fs.writeFileSync(outFile, report, "utf8");
console.log(`\n${report}`);
console.log(`[s0] 报告写入 ${outFile}`);
if (verdict.startsWith("NO-GO")) process.exit(1);
