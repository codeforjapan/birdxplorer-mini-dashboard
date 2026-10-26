import { beforeAll, describe, expect, it } from "vitest";
import type { TenantRecord, TenantSettings } from "./types";

const settings: TenantSettings = {
  slug: "repo-test",
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
};

const rec: Omit<TenantRecord, "updatedAt" | "searchlightStoppedAt"> = {
  slug: "repo-test",
  type: "disaster",
  status: "active",
  settings,
  overrides: { binMinutes: 30 },
};

// 実 DB が要る。TEST_DATABASE_URL（Neon のテスト用ブランチ等、使い捨ての空 DB）がある時だけ走らせる。
// 本番の DATABASE_URL を誤って叩かないよう、DATABASE_URL はこの値で上書きする。
describe.skipIf(!process.env.TEST_DATABASE_URL)("tenant repo（実 DB）", () => {
  let repo: typeof import("./repo");
  let db: typeof import("../db");

  beforeAll(async () => {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    process.env.BLOB_READ_WRITE_TOKEN ??= "test";
    // env() は初回呼び出しで環境変数を読んでメモ化するため、上書きの後で読み込む
    db = await import("../db");
    repo = await import("./repo");
    await db.migrate();
  });

  it("upsertTenant → getTenant で往復一致する", async () => {
    await repo.upsertTenant(rec);
    const got = await repo.getTenant("repo-test");
    expect(got).toMatchObject(rec);
    expect(got?.searchlightStoppedAt).toBeNull();
    expect(got?.updatedAt).toBeGreaterThan(0);
  });

  it("未登録の slug は null", async () => {
    expect(await repo.getTenant("no-such-tenant")).toBeNull();
  });

  it("upsertTenant は更新もでき、searchlight_stopped_at を消さない", async () => {
    await repo.upsertTenant(rec);
    await repo.markSearchlightStopped("repo-test", 12345);
    await repo.upsertTenant({ ...rec, status: "ended" });
    const got = await repo.getTenant("repo-test");
    expect(got?.status).toBe("ended");
    expect(got?.searchlightStoppedAt).toBe(12345);
  });

  it("listTenants に含まれる", async () => {
    await repo.upsertTenant(rec);
    const slugs = (await repo.listTenants()).map((t) => t.slug);
    expect(slugs).toContain("repo-test");
  });

  it("migrate() を2回呼んでも2回目は何も流さない", async () => {
    const count = async () => {
      const rows = await db.sql().query("select count(*)::int as n, max(applied_at) as last from schema_migrations");
      return rows[0];
    };
    const before = await count();
    await db.migrate();
    expect(await count()).toEqual(before);
  });
});
