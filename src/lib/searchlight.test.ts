import { describe, expect, it, vi } from "vitest";
import type { SearchlightSession } from "./searchlight-http";

vi.mock("./env", () => ({ searchlightEnv: () => ({ SEARCHLIGHT_COMPANY_ID: "co1" }) }));

import { disableCollection, getCrossInsightsFor, getInsights, planCollectionShutdown } from "./searchlight";

const enabledTopic = (id: string) => ({
  id,
  collectionConfig: { enabled: true, platforms: [{ platform: "x", enabled: true }] },
});

function recordingSession(topics: unknown = []): { session: SearchlightSession; gets: string[]; puts: string[] } {
  const gets: string[] = [];
  const puts: string[] = [];
  const session: SearchlightSession = {
    async getJson(path) {
      gets.push(path);
      return path.endsWith("/topics") ? topics : [];
    },
    async putJson(path) {
      puts.push(path);
    },
    requestCount: 0,
  };
  return { session, gets, puts };
}

describe("planCollectionShutdown", () => {
  const topics = [enabledTopic("t1"), enabledTopic("t2"), enabledTopic("t3")];

  it("指定 topic だけの計画を返す", () => {
    const { topicFound, plans } = planCollectionShutdown(topics, "t2");
    expect(topicFound).toBe(true);
    expect(plans.map((p) => p.topicId)).toEqual(["t2"]);
  });

  it("指定 topic が既に無効なら、見つかったうえで計画は空", () => {
    const off = { id: "t2", collectionConfig: { enabled: false, platforms: [{ enabled: false }] } };
    expect(planCollectionShutdown([enabledTopic("t1"), off], "t2")).toEqual({ topicFound: true, plans: [] });
  });

  it("指定 topic が一覧に無ければ topicFound=false（既に無効とは区別する）", () => {
    expect(planCollectionShutdown([enabledTopic("t1")], "typo")).toEqual({ topicFound: false, plans: [] });
  });

  it("指定 topic の collectionConfig が読めなければ例外（止める対象なしと誤認しない）", () => {
    expect(() => planCollectionShutdown([{ id: "t2", collectionConfig: null }], "t2")).toThrow(/collectionConfig/);
    expect(() => planCollectionShutdown([{ id: "t2", collectionConfig: { enabled: true } }], "t2")).toThrow();
  });

  it("他の topic の collectionConfig が壊れていても無関係", () => {
    expect(planCollectionShutdown([{ id: "t1", collectionConfig: null }, enabledTopic("t2")], "t2").plans).toHaveLength(1);
  });
});

describe("topic 絞り込み", () => {
  it("getInsights は全リクエストに topic_id を付ける", async () => {
    const { session, gets } = recordingSession();
    await getInsights(session, "t2", 0);
    expect(gets.length).toBeGreaterThan(0);
    for (const g of gets) expect(g).toContain("&topic_id=t2");
  });

  it("getCrossInsightsFor も topic_id を付け、特殊文字はエンコードする", async () => {
    const { session, gets } = recordingSession();
    await getCrossInsightsFor(session, "a/b", "web", 0);
    for (const g of gets) expect(g).toContain("&topic_id=a%2Fb");
  });

  it("disableCollection は指定 topic だけ PUT する", async () => {
    const { session, puts } = recordingSession([enabledTopic("t1"), enabledTopic("t2")]);
    expect(await disableCollection(session, "t2")).toEqual({ topicFound: true, topicsDisabled: 1 });
    expect(puts).toEqual(["/companies/co1/topics/t2"]);
  });
});
