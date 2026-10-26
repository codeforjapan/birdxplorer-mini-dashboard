import { TENANT_PRESETS } from "./presets";
import type { PublicTenantConfig, Taxonomy, TenantConfig, TenantRecord } from "./types";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 空文字・空白だけの上書きは「上書きなし」として型の値を残す。
 * 空のまま通すと、判断基準が抜けたプロンプトを LLM に送ってしまうため。
 */
function mergeTaxonomy(base: Taxonomy, override: Partial<Taxonomy> | undefined): Taxonomy {
  if (!override) return base;
  const merged: Taxonomy = { ...base };
  for (const key of Object.keys(base) as (keyof Taxonomy)[]) {
    const value = override[key];
    if (typeof value === "string" && value.trim() !== "") {
      merged[key] = value;
    }
  }
  return merged;
}

export function resolveTenantConfig(
  rec: Pick<TenantRecord, "type" | "status" | "settings" | "overrides">,
): TenantConfig {
  const preset = TENANT_PRESETS[rec.type];
  const o = rec.overrides;
  return {
    ...rec.settings,
    type: rec.type,
    status: rec.status,
    taxonomy: mergeTaxonomy(preset.taxonomy, o.taxonomy),
    relevanceMode: o.relevanceMode ?? preset.relevanceMode,
    relevanceThreshold: o.relevanceThreshold ?? preset.relevanceThreshold,
    binMinutes: o.binMinutes ?? preset.binMinutes,
    classifierVersion: preset.classifierVersion,
  };
}

/**
 * 終了日（JST）を過ぎているか。env.ts の isMonitoringEnded と同じ式で、
 * 終了日の当日いっぱいは監視中、翌日 00:00 JST から終了。
 */
export function isTenantMonitoringEnded(
  cfg: Pick<TenantConfig, "monitorEndDate">,
  now: number = Date.now(),
): boolean {
  const endExclusive = Date.parse(`${cfg.monitorEndDate}T00:00:00+09:00`) + DAY_MS;
  return now >= endExclusive;
}

/** draft / ended は終了日や開始日に関係なく監視対象外。 */
export function isTenantMonitoring(
  cfg: Pick<TenantConfig, "status" | "monitorStartAt" | "monitorEndDate">,
  now: number = Date.now(),
): boolean {
  if (cfg.status !== "active") return false;
  if (now < cfg.monitorStartAt) return false;
  return !isTenantMonitoringEnded(cfg, now);
}

/** 公開してよい項目だけを明示的に選ぶ（Blob に書かれる）。新項目は自動では漏れない。 */
export function toPublicConfig(cfg: TenantConfig): PublicTenantConfig {
  return {
    slug: cfg.slug,
    siteTitle: cfg.siteTitle,
    siteDescription: cfg.siteDescription,
    eyebrowLabel: cfg.eyebrowLabel,
    scheduleLabel: cfg.scheduleLabel,
    monitorStartAt: cfg.monitorStartAt,
    monitorEndDate: cfg.monitorEndDate,
    keyMoments: cfg.keyMoments,
    keyMomentLabel: cfg.keyMomentLabel,
    keyMomentValue: cfg.keyMomentValue,
    issuesUrl: cfg.issuesUrl,
    officialSourcesIntro: cfg.officialSourcesIntro,
    officialSources: cfg.officialSources,
    officialSourcesDisclaimer: cfg.officialSourcesDisclaimer,
    binMinutes: cfg.binMinutes,
    status: cfg.status,
    hasSearchlight: cfg.searchlightTopicId !== null,
  };
}
