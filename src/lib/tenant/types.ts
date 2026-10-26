/**
 * テナント（事例）設定の型。
 *
 * 型（disaster / election）が既定値を持ち、事例ごとの settings と overrides がそれを上書きする。
 * 解決済みの形が TenantConfig で、アプリ内の各所はこれだけを見る。
 */

export type TenantTypeId = "disaster" | "election";
export type RelevanceMode = "score" | "binary";
export type TenantStatus = "draft" | "active" | "ended";
export type KeyMoment = { at: number; markerLabel: string };
export type OfficialSource = { label: string; url: string };

export type Taxonomy = {
  searchTermExamples: string;
  relevantExamples: string;
  irrelevantExamples: string;
  clusterNamingGoodExamples: string;
  clusterNamingBadExamples: string;
  clusterNamingGoodExampleSingle: string;
  clusterNamingBadExampleSingle: string;
  overMergeCounterExample: string;
  /** 選挙型のみ非 null。実在の候補者への評価になる命名を避けるための規約 */
  namingNeutralityRule: string | null;
};

export type TenantTypePreset = {
  id: TenantTypeId;
  label: string;
  taxonomy: Taxonomy;
  relevanceMode: RelevanceMode;
  relevanceThreshold: number;
  binMinutes: number;
  /** 分類結果の世代識別子。例 "disaster-v3", "election-v2" */
  classifierVersion: string;
};

export type TenantSettings = {
  slug: string;
  siteTitle: string;
  siteDescription: string;
  eyebrowLabel: string;
  scheduleLabel: string;
  monitorStartAt: number;
  /** "YYYY-MM-DD"（JST） */
  monitorEndDate: string;
  searchKeywords: string[];
  llmContextPhrase: string;
  llmContextPhraseCompact: string;
  llmContextPhraseShort: string;
  keyMoments: KeyMoment[];
  keyMomentLabel: string;
  keyMomentValue: string;
  githubRepo: string;
  appTitle: string;
  issuesUrl: string;
  officialSourcesIntro: string;
  officialSources: OfficialSource[];
  officialSourcesDisclaimer: string;
  searchlightTopicId: string | null;
};

export type TenantOverrides = {
  relevanceMode?: RelevanceMode;
  relevanceThreshold?: number;
  binMinutes?: number;
  taxonomy?: Partial<Taxonomy>;
};

export type TenantRecord = {
  slug: string;
  type: TenantTypeId;
  status: TenantStatus;
  settings: TenantSettings;
  overrides: TenantOverrides;
  searchlightStoppedAt: number | null;
  updatedAt: number;
};

export type TenantConfig = TenantSettings & {
  type: TenantTypeId;
  status: TenantStatus;
  taxonomy: Taxonomy;
  relevanceMode: RelevanceMode;
  relevanceThreshold: number;
  binMinutes: number;
  classifierVersion: string;
};

/** 公開ページに渡してよい部分。Blob に書くので秘密・内部値を含めない */
export type PublicTenantConfig = Pick<
  TenantConfig,
  | "slug"
  | "siteTitle"
  | "siteDescription"
  | "eyebrowLabel"
  | "scheduleLabel"
  | "monitorStartAt"
  | "monitorEndDate"
  | "keyMoments"
  | "keyMomentLabel"
  | "keyMomentValue"
  | "issuesUrl"
  | "officialSourcesIntro"
  | "officialSources"
  | "officialSourcesDisclaimer"
  | "binMinutes"
  | "status"
> & { hasSearchlight: boolean };
