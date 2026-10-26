import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CrossPostRow, SearchlightInsightRow } from "./searchlight";
import type { Cluster, JobRun, Note } from "./types";
import type { TenantSettings } from "./tenant/types";

const settingsFor = (slug: string): TenantSettings => ({
  slug,
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
  keyMoments: [{ at: 1_000, markerLabel: "本震" }],
  keyMomentLabel: "ラベル",
  keyMomentValue: "値",
  githubRepo: "owner/repo",
  appTitle: "app",
  issuesUrl: "https://example.com/issues",
  officialSourcesIntro: "",
  officialSources: [{ label: "公式", url: "https://example.com" }],
  officialSourcesDisclaimer: "",
  searchlightTopicId: null,
});

const cluster = (name: string): Cluster => ({
  id: "c1",
  name,
  description: "",
  colorIndex: 0,
  createdAt: 1_000,
  aliasOf: null,
});

const note = (over: Partial<Note>): Note => ({
  noteId: "n1",
  postId: "p1",
  createdAt: 2_000,
  summary: "s",
  postUrl: "https://x.com/user/status/p1",
  currentStatus: "NEEDS_MORE_RATINGS",
  helpfulCount: 0,
  notHelpfulCount: 0,
  rateCount: 0,
  impressionCount: null,
  statusRefreshedAt: 2_000,
  relevance: 80,
  excluded: false,
  excludeReason: null,
  clusterId: null,
  classifiedAt: 3_000,
  classifierVersion: "test",
  ...over,
});

const insight = (over: Partial<SearchlightInsightRow>): SearchlightInsightRow => ({
  tweet_id: "t1",
  stance: "SPREADING",
  urgency: "HIGH",
  claim_type: "RUMOR_OR_UNVERIFIED",
  official_source_relationship: "conflicts_with_official_source",
  official_source_url: null,
  synced_at: 1_000,
  ...over,
});

const crossPost = (over: Partial<CrossPostRow>): CrossPostRow => ({
  insight_id: "i1",
  platform: "youtube",
  url: "https://www.youtube.com/watch?v=x",
  stance: null,
  urgency: "LOW",
  claim_type: "RUMOR_OR_UNVERIFIED",
  official_source_relationship: "no_official_source",
  official_source_url: null,
  claim_summary: "要約",
  published_at: null,
  synced_at: 1_000,
  views: null,
  likes: null,
  comments: null,
  shares: null,
  collects: null,
  flame_rate: null,
  ...over,
});

// neon() は Neon の HTTP エンドポイントにしか話せないので、素の Postgres へ繋ぐアダプタに差し替える
// （db.ts の sql()・migrate() は実物のまま動かす）
vi.mock("@neondatabase/serverless", async () => {
  const { createPgSql } = await import("@/test/pg-sql");
  return { neon: (url: string) => createPgSql(url) };
});

// 実 DB が要る。TEST_DATABASE_URL（使い捨ての空 Postgres）がある時だけ走らせる。
describe.skipIf(!process.env.TEST_DATABASE_URL)("事例間のデータ分離（実 DB）", () => {
  let store: typeof import("./store");
  let state: typeof import("./state");
  let db: typeof import("./db");

  beforeAll(async () => {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    process.env.BLOB_READ_WRITE_TOKEN ??= "test";
    db = await import("./db");
    const repo = await import("./tenant/repo");
    await db.migrate();
    // tenant_id は tenants(slug) への外部キーなので、先に事例を作る
    for (const slug of ["iso-a", "iso-b"]) {
      await repo.upsertTenant({
        slug,
        type: "disaster",
        status: "active",
        settings: settingsFor(slug),
        overrides: {},
      });
    }
    store = await import("./store");
    state = await import("./state");
  });

  // 実行順や前回の実行の残りに結果が左右されないよう、iso-* の行を毎回消してから始める。
  // notes は clusters を外部キーで参照するので先に消す
  beforeEach(async () => {
    for (const table of [
      "notes",
      "clusters",
      "retry_queue",
      "job_runs",
      "app_state",
      "searchlight_insights",
      "searchlight_cross_posts",
    ]) {
      await db.sql().query(`delete from ${table} where tenant_id like 'iso-%'`);
    }
  });

  afterAll(async () => {
    const { closePgPools } = await import("@/test/pg-sql");
    await closePgPools();
  });

  it("同じ note_id・cluster_id でも事例ごとに独立して保存される", async () => {
    await store.upsertClusters("iso-a", [cluster("A のクラスタ")]);
    await store.upsertClusters("iso-b", [cluster("B のクラスタ")]);
    await store.upsertNotes("iso-a", [note({ excluded: true, excludeReason: "無関係", clusterId: null })]);
    await store.upsertNotes("iso-b", [note({ excluded: false, clusterId: "c1" })]);

    const a = (await store.readNotes("iso-a")).find((n) => n.noteId === "n1");
    const b = (await store.readNotes("iso-b")).find((n) => n.noteId === "n1");
    expect(a?.excluded).toBe(true);
    expect(a?.clusterId).toBeNull();
    expect(b?.excluded).toBe(false);
    expect(b?.clusterId).toBe("c1");

    const ca = (await store.readClusters("iso-a")).find((c) => c.id === "c1");
    const cb = (await store.readClusters("iso-b")).find((c) => c.id === "c1");
    expect(ca?.name).toBe("A のクラスタ");
    expect(cb?.name).toBe("B のクラスタ");
  });

  it("applyStatusRefresh は他の事例の行を更新しない", async () => {
    await store.upsertNotes("iso-a", [note({})]);
    await store.upsertNotes("iso-b", [note({})]);
    await store.applyStatusRefresh(
      "iso-a",
      [{ noteId: "n1", currentStatus: "CURRENTLY_RATED_HELPFUL", helpfulCount: 9, notHelpfulCount: 0, rateCount: 9 }],
      5_000,
    );
    const b = (await store.readNotes("iso-b")).find((n) => n.noteId === "n1");
    expect(b?.currentStatus).toBe("NEEDS_MORE_RATINGS");
    expect(b?.helpfulCount).toBe(0);
  });

  it("filterUnseen は自分の事例の既知 note_id だけを除く", async () => {
    await store.upsertNotes("iso-a", [note({ noteId: "n1" })]);
    expect(await state.filterUnseen("iso-a", ["n1", "n2"])).toEqual(["n2"]);
    // n1 は iso-a・iso-b に存在するが、データの無い iso-c から見れば未処理のまま
    // （filterUnseen は読み取りだけなので iso-c に tenants 行は要らない）
    expect(await state.filterUnseen("iso-c", ["n1"])).toEqual(["n1"]);
  });

  it("再試行キューは事例ごとで、drain は他事例の行を取り出さない", async () => {
    await state.enqueueRetry("iso-a", "r1", "boom", 1);
    await state.enqueueRetry("iso-b", "r1", "boom", 1);
    await state.enqueueRetry("iso-b", "r1", "boom", 2);

    expect(await state.countRetryQueue("iso-a")).toBe(1);
    const drained = await state.drainRetryQueue("iso-a", 10);
    expect(drained.map((e) => [e.noteId, e.attempts])).toEqual([["r1", 1]]);
    // b の行は残り、attempts も b の分だけ加算されている
    const rest = await state.drainRetryQueue("iso-b", 10);
    expect(rest.map((e) => [e.noteId, e.attempts])).toEqual([["r1", 2]]);
  });

  it("recordRun は他の事例の getRun に見えない", async () => {
    const run: JobRun = { job: "ingest", startedAt: 1, finishedAt: 2, ok: true, stats: { n: 1 }, error: null };
    await state.recordRun("iso-a", run);
    expect((await state.getRun("iso-a", "ingest"))?.ok).toBe(true);
    expect(await state.getRun("iso-b", "ingest")).toBeNull();
  });

  it("同じ tweet_id・insight_id の Searchlight 行も事例ごとに独立して保存される", async () => {
    await store.upsertSearchlightInsights("iso-a", [insight({ urgency: "HIGH" })]);
    await store.upsertSearchlightInsights("iso-b", [insight({ urgency: "LOW", stance: null })]);
    await store.upsertCrossPosts("iso-a", [crossPost({ claim_summary: "A の要約", views: 10 })]);
    await store.upsertCrossPosts("iso-b", [crossPost({ claim_summary: "B の要約", views: 20 })]);
    // b の再 upsert が a の行を上書きしないことも見る
    await store.upsertSearchlightInsights("iso-b", [insight({ urgency: "MEDIUM", stance: null })]);

    const insights = await db.sql()`
      select tenant_id, urgency, stance from searchlight_insights
      where tenant_id like 'iso-%' and tweet_id = 't1' order by tenant_id`;
    expect(insights).toEqual([
      { tenant_id: "iso-a", urgency: "HIGH", stance: "SPREADING" },
      { tenant_id: "iso-b", urgency: "MEDIUM", stance: null },
    ]);

    const cross = await db.sql()`
      select tenant_id, claim_summary, views::int as views from searchlight_cross_posts
      where tenant_id like 'iso-%' and insight_id = 'i1' order by tenant_id`;
    expect(cross).toEqual([
      { tenant_id: "iso-a", claim_summary: "A の要約", views: 10 },
      { tenant_id: "iso-b", claim_summary: "B の要約", views: 20 },
    ]);
  });
});
