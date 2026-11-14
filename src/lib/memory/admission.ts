// src/lib/memory/admission.ts
//
// §5.3 准入规则 — 防污染的关键。
//
// 记忆是「网页内容 → 记忆 → 每次任务注入」的持久化 prompt injection 通道
// （调研 §4.7 / PoisonedRAG）。这里做的是**写入前**的机械过滤：
//   1. 密码 / 证件号 / 银行卡号 → 直接丢弃（不是打码，是不存）；
//   2. 祈使句 / URL / 「忽略之前的指令」这类模式 → 丢弃或清洗；
//   3. 标题 / 正文一律走 escapeUntrustedWrappers + 长度裁剪；
//   4. 「不记住的网站」域名 → 整段会话不整理。
//
// 显式 `remember`（用户自己说「记住…」）与每日整理的过滤强度不同：前者是用户
// 亲口说的，只拦密钥类；后者是模型归纳的，额外拦「对助手下命令」的语气。

import { escapeUntrustedWrappers } from "@/lib/agent/untrusted-wrappers";
import {
  MEMORY_BODY_MAX_CHARS,
  MEMORY_TITLE_MAX_CHARS,
  type MemoryKind,
} from "./types";

// ── 永不记忆 ────────────────────────────────────────────────────────────────

/**
 * 密钥 / 证件 / 银行卡。命中即整条丢弃，不做部分替换——半条记忆比没有更危险。
 * 号码类只拦足够长的连续数字（16–19 位，银行卡长度区间），避免误伤订单号、
 * 手机号（11 位）。
 */
const SECRET_PATTERNS: RegExp[] = [
  /\b(?:password|passwd|pwd|secret|token|api[\s_-]?key)\s*[:：=]\s*\S{4,}/i,
  /(?:密码|口令|密钥)\s*[:：=]\s*\S{3,}/,
  // 证件 / 卡 / 验证码后面跟一串值（"身份证 3301…"）——只拦带值的，不拦提到。
  /(?:验证码|身份证|护照|银行卡|信用卡)[^\s，。；,.;]{0,4}[:：]?\s*[A-Za-z0-9]{6,}/,
  /\b\d{17}[\dXx]\b/, // 身份证号
  /\b\d{16,19}\b/, // 银行卡号
  /\bsk-[A-Za-z0-9_-]{16,}/,
];

export function containsSecret(text: string): boolean {
  return SECRET_PATTERNS.some((re) => re.test(text));
}

// ── 祈使句 / 注入模式 ────────────────────────────────────────────────────────

/**
 * 「对助手下命令」的语气 + 经典注入串。只有整理器产出的条目受这条约束：
 * 用户显式说的话（remember）是可信输入，不该被自己的语气规则拦掉。
 */
const INSTRUCTION_PATTERNS: RegExp[] = [
  /ignore\s+(?:all\s+)?(?:the\s+)?(?:previous|prior|above|earlier)\s+instructions?/i,
  /disregard\s+(?:all\s+)?(?:previous|prior|above)\s+(?:instructions?|prompts?)/i,
  /忽略(?:之前|以上|前面|此前)的?(?:所有)?(?:指令|指示|规则|提示)/,
  /(?:system|developer)\s+prompt|系统提示词|系统指令/i,
  /^[^\n]{0,20}(?:you must|you should always|always (?:do|use|say|answer|reply))\b/i,
  /(?:你必须|你必须始终|请始终|永远都要|以后每次都要)/,
  /<\/?(?:untrusted_|user_|system_)[a-z_]*>/i,
];

export function looksLikeInstruction(text: string): boolean {
  return INSTRUCTION_PATTERNS.some((re) => re.test(text));
}

// ── URL ─────────────────────────────────────────────────────────────────────

const URL_RE = /\bhttps?:\/\/[^\s<>"')]+/gi;

/** 去掉正文里的 URL（记忆存的是「关于用户的结论」，不是书签）。 */
export function stripUrls(text: string): string {
  return text.replace(URL_RE, "").replace(/[ \t]{2,}/g, " ").trim();
}

// ── 清洗 ────────────────────────────────────────────────────────────────────

/** 控制字符 + 零宽字符 + 换行压平（记忆一条一行）。 */
const CONTROL_RE = /[\u0000-\u0008\u000b-\u001f\u007f​-‏⁠﻿]/g;

export function normalizeMemoryText(raw: string, maxChars: number): string {
  const flat = String(raw ?? "")
    .replace(CONTROL_RE, "")
    .replace(/\s+/g, " ")
    .trim();
  const escaped = escapeUntrustedWrappers(flat);
  return escaped.slice(0, maxChars).trim();
}

// ── 准入判定 ────────────────────────────────────────────────────────────────

export interface MemoryCandidate {
  kind: MemoryKind;
  title: string;
  body: string;
  tags?: string[];
}

export interface AdmitOptions {
  /**
   * "explicit"/"user"：用户亲口说的或亲手编辑的 → 只拦密钥类。
   * "consolidated"：整理器归纳的 → 额外拦祈使句 / 注入模式 / URL 为主的条目。
   */
  origin: "explicit" | "user" | "consolidated";
}

export type AdmitResult =
  | { ok: true; title: string; body: string; tags: string[] }
  | { ok: false; reason: string };

export function admitMemoryCandidate(
  c: MemoryCandidate,
  opts: AdmitOptions,
): AdmitResult {
  const title = normalizeMemoryText(c.title, MEMORY_TITLE_MAX_CHARS);
  let body = normalizeMemoryText(c.body, MEMORY_BODY_MAX_CHARS);
  if (!title && !body) return { ok: false, reason: "empty" };

  // 密钥 / 证件 / 银行卡：任何来源都不存。
  if (containsSecret(`${title}\n${body}`)) {
    return { ok: false, reason: "secret" };
  }

  if (opts.origin === "consolidated") {
    const stripped = stripUrls(body);
    if (!stripped && URL_RE.test(body)) return { ok: false, reason: "url_only" };
    body = stripped;
    if (looksLikeInstruction(`${title}\n${body}`)) {
      return { ok: false, reason: "instruction" };
    }
  }

  if (!body) body = title;
  const tags = (c.tags ?? [])
    .map((t) => normalizeMemoryText(t, 24))
    .filter(Boolean)
    .slice(0, 6);
  return { ok: true, title: title || body.slice(0, MEMORY_TITLE_MAX_CHARS), body, tags };
}

// ── 不记住的网站 ────────────────────────────────────────────────────────────

/** 从 origin（"https://mail.example.com"）取 host。解析失败原样返回小写。 */
export function hostOf(originOrUrl: string): string {
  try {
    return new URL(originOrUrl).host.toLowerCase();
  } catch {
    return originOrUrl.toLowerCase();
  }
}

/**
 * 域名命中判定：`example.com` 命中 `mail.example.com` 与 `example.com`；
 * 反过来不命中。列表项本身可以带 `www.`。
 */
export function isDomainExcluded(
  host: string,
  excludedDomains: readonly string[],
): boolean {
  const h = hostOf(host).replace(/^www\./, "");
  return excludedDomains.some((d) => {
    const raw = d.trim().toLowerCase().replace(/^www\./, "");
    if (!raw) return false;
    return h === raw || h.endsWith("." + raw);
  });
}
