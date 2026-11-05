import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveTenantConfig } from "@/lib/tenant/resolve";
import type { TenantConfig, TenantSettings, TenantTypeId } from "@/lib/tenant/types";
import type { Cluster } from "@/lib/types";

const mocks = vi.hoisted(() => ({
  scoreRelevance: vi.fn(),
  judgeRelevance: vi.fn(),
  assignClusters: vi.fn(),
}));

vi.mock("@/lib/llm", () => ({
  scoreRelevance: mocks.scoreRelevance,
  judgeRelevance: mocks.judgeRelevance,
  assignClusters: mocks.assignClusters,
}));

import { classifyBatch } from "./classify";

const S: TenantSettings = {
  slug: "t",
  siteTitle: "テスト",
  siteDescription: "説明",
  eyebrowLabel: "e",
  scheduleLabel: "s",
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

function cfgOf(type: TenantTypeId): TenantConfig {
  return resolveTenantConfig({ slug: S.slug, type, status: "active", settings: S, overrides: {} });
}

const candidates = [
  { noteId: "a", summary: "A", postText: null },
  { noteId: "b", summary: "B", postText: null },
];

beforeEach(() => {
  vi.clearAllMocks();
});

describe("classifyBatch", () => {
  it("binary: judgeRelevance だけを呼び、unrelated は 0/除外、related は 100 で Stage2 へ", async () => {
    const cfg = cfgOf("election");
    mocks.judgeRelevance.mockResolvedValue({
      results: [
        { noteId: "a", verdict: "related", reason: "関係" },
        { noteId: "b", verdict: "unrelated", reason: "無関係" },
      ],
      failedNoteIds: [],
    });
    mocks.assignClusters.mockResolvedValue({
      results: [{ noteId: "a", kind: "new", name: "噂", description: "説明" }],
      failedNoteIds: [],
    });

    const clusters: Cluster[] = [];
    const r = await classifyBatch(cfg, clusters, candidates);

    expect(mocks.judgeRelevance).toHaveBeenCalledTimes(1);
    expect(mocks.scoreRelevance).not.toHaveBeenCalled();
    expect(mocks.judgeRelevance.mock.calls[0][0]).toBe(cfg);
    // Stage2 には related の a だけが進む
    expect(mocks.assignClusters.mock.calls[0][2]).toEqual([{ noteId: "a", summary: "A" }]);

    expect(r.classifications.get("b")).toMatchObject({
      relevance: 0,
      excluded: true,
      excludeReason: "無関係",
      clusterId: null,
      classifierVersion: cfg.classifierVersion,
    });
    expect(r.classifications.get("a")).toMatchObject({
      relevance: 100,
      excluded: false,
      classifierVersion: cfg.classifierVersion,
    });
    expect(r.classifications.get("a")?.clusterId).toBeTruthy();
    expect(r.newClusters).toHaveLength(1);
  });

  it("score: scoreRelevance だけを呼び、閾値未満を除外する", async () => {
    const cfg = cfgOf("disaster");
    mocks.scoreRelevance.mockResolvedValue({
      results: [
        { noteId: "a", relevance: cfg.relevanceThreshold, reason: "ちょうど閾値" },
        { noteId: "b", relevance: cfg.relevanceThreshold - 1, reason: "閾値未満" },
      ],
      failedNoteIds: [],
    });
    mocks.assignClusters.mockResolvedValue({
      results: [{ noteId: "a", kind: "new", name: "噂", description: "説明" }],
      failedNoteIds: [],
    });

    const r = await classifyBatch(cfg, [], candidates);

    expect(mocks.scoreRelevance).toHaveBeenCalledTimes(1);
    expect(mocks.judgeRelevance).not.toHaveBeenCalled();
    expect(mocks.assignClusters.mock.calls[0][2]).toEqual([{ noteId: "a", summary: "A" }]);
    expect(r.classifications.get("b")).toMatchObject({
      relevance: cfg.relevanceThreshold - 1,
      excluded: true,
      classifierVersion: cfg.classifierVersion,
    });
    expect(r.classifications.get("a")).toMatchObject({
      relevance: cfg.relevanceThreshold,
      excluded: false,
      classifierVersion: cfg.classifierVersion,
    });
  });

  it("判定に失敗したノートは分類せず failedNoteIds に積む", async () => {
    const cfg = cfgOf("election");
    mocks.judgeRelevance.mockResolvedValue({ results: [], failedNoteIds: ["a", "b"] });
    mocks.assignClusters.mockResolvedValue({ results: [], failedNoteIds: [] });
    const r = await classifyBatch(cfg, [], candidates);
    expect([...r.failedNoteIds].sort()).toEqual(["a", "b"]);
    expect(r.classifications.size).toBe(0);
  });
});
