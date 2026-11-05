import { TENANT_PRESETS } from "../tenant/presets";
import type { TenantInput } from "../tenant/input";
import type {
  OfficialSource,
  RelevanceMode,
  Taxonomy,
  TenantOverrides,
  TenantRecord,
  TenantSettings,
  TenantStatus,
  TenantTypeId,
} from "../tenant/types";

// クライアントからも読み込むので、Node 専用の import や env 参照は置かない

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

export type TenantFormValues = Omit<
  TenantSettings,
  "searchlightTopicId" | "monitorStartAt" | "keyMoments" | "searchKeywords"
> & {
  type: TenantTypeId;
  /** JST の "YYYY-MM-DDTHH:mm" */
  monitorStartAt: string;
  keyMoments: { at: string; markerLabel: string }[];
  /** 1行1語 */
  searchKeywords: string;
  taxonomy: Taxonomy;
  relevanceMode: RelevanceMode;
  relevanceThreshold: number;
  binMinutes: number;
};

// JST は夏時間がないので固定 +09:00 で足し引きすれば端末の TZ に依らない
function msToJst(ms: number): string {
  return new Date(ms + JST_OFFSET_MS).toISOString().slice(0, 16);
}

// 不正値は NaN にして、検証側（zod）に弾かせる
function jstToMs(s: string): number {
  return Date.parse(`${s}+09:00`);
}

const TAXONOMY_KEYS: (keyof Taxonomy)[] = [
  "searchTermExamples",
  "relevantExamples",
  "irrelevantExamples",
  "clusterNamingGoodExamples",
  "clusterNamingBadExamples",
  "clusterNamingGoodExampleSingle",
  "clusterNamingBadExampleSingle",
  "overMergeCounterExample",
  "namingNeutralityRule",
];

export function newFormValues(type: TenantTypeId): TenantFormValues {
  const p = TENANT_PRESETS[type];
  return {
    slug: "",
    hostLabel: "",
    type,
    siteTitle: "",
    siteDescription: "",
    eyebrowLabel: "",
    scheduleLabel: "",
    monitorStartAt: "",
    monitorEndDate: "",
    searchKeywords: "",
    llmContextPhrase: "",
    llmContextPhraseCompact: "",
    llmContextPhraseShort: "",
    keyMoments: [],
    keyMomentLabel: "",
    keyMomentValue: "",
    githubRepo: "codeforjapan/birdxplorer-mini-dashboard",
    appTitle: "birdxplorer-mini-dashboard",
    issuesUrl: "https://github.com/codeforjapan/birdxplorer-mini-dashboard/issues",
    officialSourcesIntro: "",
    officialSources: [],
    officialSourcesDisclaimer: "",
    taxonomy: { ...p.taxonomy },
    relevanceMode: p.relevanceMode,
    relevanceThreshold: p.relevanceThreshold,
    binMinutes: p.binMinutes,
  };
}

export function formValuesFromRecord(rec: TenantRecord): TenantFormValues {
  const p = TENANT_PRESETS[rec.type];
  const o = rec.overrides;
  const s = rec.settings;
  const taxonomy: Taxonomy = { ...p.taxonomy };
  for (const key of TAXONOMY_KEYS) {
    const v = o.taxonomy?.[key];
    // resolve.ts と同じく、空白だけの上書きは「上書きなし」
    if (typeof v === "string" && v.trim() !== "") (taxonomy[key] as string | null) = v;
  }
  return {
    slug: rec.slug,
    hostLabel: s.hostLabel,
    type: rec.type,
    siteTitle: s.siteTitle,
    siteDescription: s.siteDescription,
    eyebrowLabel: s.eyebrowLabel,
    scheduleLabel: s.scheduleLabel,
    monitorStartAt: msToJst(s.monitorStartAt),
    monitorEndDate: s.monitorEndDate,
    searchKeywords: s.searchKeywords.join("\n"),
    llmContextPhrase: s.llmContextPhrase,
    llmContextPhraseCompact: s.llmContextPhraseCompact,
    llmContextPhraseShort: s.llmContextPhraseShort,
    keyMoments: s.keyMoments.map((k) => ({ at: msToJst(k.at), markerLabel: k.markerLabel })),
    keyMomentLabel: s.keyMomentLabel,
    keyMomentValue: s.keyMomentValue,
    githubRepo: s.githubRepo,
    appTitle: s.appTitle,
    issuesUrl: s.issuesUrl,
    officialSourcesIntro: s.officialSourcesIntro,
    officialSources: s.officialSources.map((x: OfficialSource) => ({ ...x })),
    officialSourcesDisclaimer: s.officialSourcesDisclaimer,
    taxonomy,
    relevanceMode: o.relevanceMode ?? p.relevanceMode,
    relevanceThreshold: o.relevanceThreshold ?? p.relevanceThreshold,
    binMinutes: o.binMinutes ?? p.binMinutes,
  };
}

export function isPresetValue(v: TenantFormValues, field: keyof Taxonomy): boolean {
  return v.taxonomy[field] === TENANT_PRESETS[v.type].taxonomy[field];
}

export function toTenantInput(
  v: TenantFormValues,
  base: { status: TenantStatus; searchlightTopicId: string | null },
): TenantInput {
  const p = TENANT_PRESETS[v.type];
  const taxonomy: Partial<Taxonomy> = {};
  for (const key of TAXONOMY_KEYS) {
    const val = v.taxonomy[key];
    // 空は「上書きなし」（resolve.ts と同じ）。既定と同じ値も入れない
    if (typeof val !== "string" || val.trim() === "" || val === p.taxonomy[key]) continue;
    (taxonomy[key] as string | null) = val;
  }
  const overrides: TenantOverrides = {};
  if (v.relevanceMode !== p.relevanceMode) overrides.relevanceMode = v.relevanceMode;
  if (v.relevanceThreshold !== p.relevanceThreshold) overrides.relevanceThreshold = v.relevanceThreshold;
  if (v.binMinutes !== p.binMinutes) overrides.binMinutes = v.binMinutes;
  if (Object.keys(taxonomy).length > 0) overrides.taxonomy = taxonomy;

  return {
    slug: v.slug,
    type: v.type,
    status: base.status,
    settings: {
      slug: v.slug,
      hostLabel: v.hostLabel,
      siteTitle: v.siteTitle,
      siteDescription: v.siteDescription,
      eyebrowLabel: v.eyebrowLabel,
      scheduleLabel: v.scheduleLabel,
      monitorStartAt: jstToMs(v.monitorStartAt),
      monitorEndDate: v.monitorEndDate,
      searchKeywords: [
        ...new Set(
          v.searchKeywords
            .split("\n")
            .map((k) => k.trim())
            .filter((k) => k !== ""),
        ),
      ],
      llmContextPhrase: v.llmContextPhrase,
      llmContextPhraseCompact: v.llmContextPhraseCompact,
      llmContextPhraseShort: v.llmContextPhraseShort,
      keyMoments: v.keyMoments.map((k) => ({ at: jstToMs(k.at), markerLabel: k.markerLabel })),
      keyMomentLabel: v.keyMomentLabel,
      keyMomentValue: v.keyMomentValue,
      githubRepo: v.githubRepo,
      appTitle: v.appTitle,
      issuesUrl: v.issuesUrl,
      officialSourcesIntro: v.officialSourcesIntro,
      officialSources: v.officialSources.map((x) => ({ ...x })),
      officialSourcesDisclaimer: v.officialSourcesDisclaimer,
      searchlightTopicId: base.searchlightTopicId,
    },
    overrides,
  };
}

/** 全体にかかる違反（path が空）は "_form" に入れる。同じ欄は最初の違反だけ残す */
export function fieldErrors(issues: { path: string; message: string }[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const i of issues) {
    const key =
      i.path === ""
        ? "_form"
        : i.path.startsWith("settings.")
          ? i.path.slice("settings.".length)
          : i.path.startsWith("overrides.")
            ? i.path.slice("overrides.".length)
            : i.path;
    if (!(key in out)) out[key] = i.message;
  }
  return out;
}
