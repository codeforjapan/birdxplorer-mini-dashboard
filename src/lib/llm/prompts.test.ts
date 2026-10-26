import { describe, expect, it } from "vitest";
import { resolveTenantConfig } from "../tenant/resolve";
import type { TenantConfig, TenantSettings, TenantTypeId } from "../tenant/types";
import { buildAssignSystemPrompt } from "./assign";
import { buildReclusterSystemPrompt } from "./recluster";
import { buildRelevanceSystemPrompt } from "./relevance";
import { buildCumulativeSystemPrompt, buildDigestSystemPrompt } from "./report";

const S: TenantSettings = {
  slug: "t",
  siteTitle: "テスト",
  siteDescription: "説明",
  eyebrowLabel: "e",
  scheduleLabel: "s",
  monitorStartAt: Date.parse("2026-08-01T00:00:00+09:00"),
  monitorEndDate: "2026-09-20",
  searchKeywords: ["あいう", "かきく"],
  llmContextPhrase: "テスト事例の全文",
  llmContextPhraseCompact: "テスト事例コンパクト",
  llmContextPhraseShort: "テスト事例短縮",
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

function cfgOf(type: TenantTypeId): TenantConfig {
  return resolveTenantConfig({ type, status: "active", settings: S, overrides: {} });
}

describe("buildRelevanceSystemPrompt", () => {
  it("災害型(score): 文脈句・関連例・閾値60の説明を含む", () => {
    const cfg = cfgOf("disaster");
    const p = buildRelevanceSystemPrompt(cfg);
    expect(p).toContain(cfg.llmContextPhrase);
    expect(p).toContain(cfg.taxonomy.relevantExamples);
    expect(p).toContain("60");
    expect(p).not.toContain("verdict");
  });

  it("選挙型(binary): related/unrelated の二値で、スコア閾値の説明を含まない", () => {
    const cfg = cfgOf("election");
    const p = buildRelevanceSystemPrompt(cfg);
    expect(p).toContain(cfg.taxonomy.relevantExamples);
    expect(p).toContain("verdict");
    expect(p).toContain("unrelated");
    expect(p).not.toContain("60以上");
  });
});

describe("中立性ルール", () => {
  it("選挙型の assign / recluster は namingNeutralityRule を含む", () => {
    const cfg = cfgOf("election");
    const rule = cfg.taxonomy.namingNeutralityRule;
    expect(rule).toBeTruthy();
    expect(buildAssignSystemPrompt(cfg)).toContain(rule as string);
    expect(buildReclusterSystemPrompt(cfg)).toContain(rule as string);
  });

  it("災害型は null なので、中立性の段落ごと出さない", () => {
    const cfg = cfgOf("disaster");
    expect(cfg.taxonomy.namingNeutralityRule).toBeNull();
    const assign = buildAssignSystemPrompt(cfg);
    const recluster = buildReclusterSystemPrompt(cfg);
    expect(assign).not.toContain("null");
    expect(recluster).not.toContain("null");
    expect(assign).not.toContain("評価にならない");
    expect(recluster).not.toContain("評価にならない");
    expect(assign).not.toMatch(/^- \s*$/m);
  });
});

describe("固有名詞のハードコード禁止", () => {
  // 型の taxonomy は熊本の具体例を持つので、その値を中立な文字列に差し替えた設定で、
  // プロンプト組み立て側に「熊本」が残っていないことを確かめる。
  for (const type of ["disaster", "election"] as const) {
    it(`${type}: 全プロンプトに「熊本」が残らない`, () => {
      const base = cfgOf(type);
      const cfg: TenantConfig = {
        ...base,
        taxonomy: Object.fromEntries(
          Object.entries(base.taxonomy).map(([k, v]) => [k, v === null ? null : "中立な例"]),
        ) as TenantConfig["taxonomy"],
      };
      const prompts = [
        buildRelevanceSystemPrompt(cfg),
        buildAssignSystemPrompt(cfg),
        buildReclusterSystemPrompt(cfg),
        buildDigestSystemPrompt(cfg),
        buildCumulativeSystemPrompt(cfg),
      ];
      for (const p of prompts) expect(p).not.toContain("熊本");
    });
  }

  it("関連性プロンプトは検索語の例を cfg.taxonomy.searchTermExamples から引く", () => {
    const cfg = cfgOf("disaster");
    expect(buildRelevanceSystemPrompt(cfg)).toContain(cfg.taxonomy.searchTermExamples);
  });

  it("累積レポートの終了日は cfg.monitorEndDate から引く", () => {
    const p = buildCumulativeSystemPrompt(cfgOf("disaster"));
    expect(p).toContain("2026年9月20日");
    expect(p).not.toContain("8月31日");
  });
});
