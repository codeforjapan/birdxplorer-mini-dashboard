import { describe, expect, it } from "vitest";
import { TENANT_PRESETS } from "./presets";
import { isTenantMonitoring, isTenantMonitoringEnded, resolveTenantConfig, toPublicConfig } from "./resolve";
import type { TenantSettings } from "./types";

const S: TenantSettings = {
  slug: "test",
  siteTitle: "テスト",
  siteDescription: "説明",
  eyebrowLabel: "eyebrow",
  scheduleLabel: "schedule",
  monitorStartAt: Date.parse("2026-08-01T00:00:00+09:00"),
  monitorEndDate: "2026-09-20",
  searchKeywords: ["テスト"],
  llmContextPhrase: "テスト",
  llmContextPhraseCompact: "テスト",
  llmContextPhraseShort: "テスト",
  keyMoments: [],
  keyMomentLabel: "",
  keyMomentValue: "",
  githubRepo: "owner/repo",
  appTitle: "app",
  issuesUrl: "https://example.com/issues",
  officialSourcesIntro: "",
  officialSources: [],
  officialSourcesDisclaimer: "",
  searchlightTopicId: null,
};

describe("resolveTenantConfig", () => {
  it("上書きの無い項目は型の値を使う", () => {
    const cfg = resolveTenantConfig({ type: "disaster", status: "active", settings: S, overrides: {} });
    expect(cfg.taxonomy).toEqual(TENANT_PRESETS.disaster.taxonomy);
    expect(cfg.binMinutes).toBe(30);
    expect(cfg.relevanceMode).toBe("score");
    expect(cfg.relevanceThreshold).toBe(60);
  });
  it("選挙型は二値判定・1440分ビン・中立性ルールあり", () => {
    const cfg = resolveTenantConfig({ type: "election", status: "active", settings: S, overrides: {} });
    expect(cfg.relevanceMode).toBe("binary");
    expect(cfg.binMinutes).toBe(1440);
    expect(cfg.taxonomy.namingNeutralityRule).not.toBeNull();
  });
  it("taxonomy の上書きは項目単位でマージする", () => {
    const cfg = resolveTenantConfig({
      type: "disaster",
      status: "active",
      settings: S,
      overrides: { taxonomy: { searchTermExamples: "「X」" } },
    });
    expect(cfg.taxonomy.searchTermExamples).toBe("「X」");
    expect(cfg.taxonomy.relevantExamples).toBe(TENANT_PRESETS.disaster.taxonomy.relevantExamples);
  });
  it("空文字の上書きは無視する（Review Focus 5）", () => {
    const cfg = resolveTenantConfig({
      type: "disaster",
      status: "active",
      settings: S,
      overrides: { taxonomy: { relevantExamples: "  " } },
    });
    expect(cfg.taxonomy.relevantExamples).toBe(TENANT_PRESETS.disaster.taxonomy.relevantExamples);
  });
});

describe("isTenantMonitoringEnded / isTenantMonitoring", () => {
  it("終了日の当日いっぱいは監視中、翌日0時JSTから終了（Review Focus 4）", () => {
    const c = { monitorEndDate: "2026-08-31" };
    expect(isTenantMonitoringEnded(c, Date.parse("2026-08-31T23:59:59+09:00"))).toBe(false);
    expect(isTenantMonitoringEnded(c, Date.parse("2026-09-01T00:00:00+09:00"))).toBe(true);
  });
  it("draft と ended は監視中ではない。開始前も監視中ではない", () => {
    const base = { monitorStartAt: Date.parse("2026-08-01T00:00:00+09:00"), monitorEndDate: "2026-09-20" };
    const now = Date.parse("2026-08-10T00:00:00+09:00");
    expect(isTenantMonitoring({ ...base, status: "active" }, now)).toBe(true);
    expect(isTenantMonitoring({ ...base, status: "draft" }, now)).toBe(false);
    expect(isTenantMonitoring({ ...base, status: "ended" }, now)).toBe(false);
    expect(isTenantMonitoring({ ...base, status: "active" }, Date.parse("2026-07-31T00:00:00+09:00"))).toBe(false);
  });
});

describe("toPublicConfig", () => {
  it("toPublicConfig は taxonomy・searchlightTopicId・githubRepo を含めない", () => {
    const pub = toPublicConfig(
      resolveTenantConfig({
        type: "election",
        status: "active",
        settings: { ...S, searchlightTopicId: "t1" },
        overrides: {},
      }),
    );
    expect(pub).not.toHaveProperty("taxonomy");
    expect(pub).not.toHaveProperty("searchlightTopicId");
    expect(pub).not.toHaveProperty("githubRepo");
    expect(pub.hasSearchlight).toBe(true);
  });
});
