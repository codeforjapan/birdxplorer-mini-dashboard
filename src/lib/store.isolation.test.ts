import { beforeAll, describe, expect, it } from "vitest";
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

// 実 DB が要る。TEST_DATABASE_URL（使い捨ての空 DB）がある時だけ走らせる。
describe.skipIf(!process.env.TEST_DATABASE_URL)("事例間のデータ分離（実 DB）", () => {
  let store: typeof import("./store");
  let state: typeof import("./state");

  beforeAll(async () => {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    process.env.BLOB_READ_WRITE_TOKEN ??= "test";
    const db = await import("./db");
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
});
