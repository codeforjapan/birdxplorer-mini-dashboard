import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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

// neon() は Neon の HTTP エンドポイントにしか話せないので、素の Postgres へ繋ぐアダプタに差し替える
// （db.ts の sql()・migrate() は実物のまま動かす）
vi.mock("@neondatabase/serverless", async () => {
  const { createPgSql } = await import("@/test/pg-sql");
  return { neon: (url: string) => createPgSql(url) };
});

// 実 DB が要る。TEST_DATABASE_URL（使い捨ての空 Postgres）がある時だけ走らせる。
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

  // 前回の実行や他のテストが残した searchlight_stopped_at に結果が左右されないよう、毎回消してから始める
  beforeEach(async () => {
    await db.sql()`delete from tenants where slug = 'repo-test'`;
  });

  afterAll(async () => {
    const { closePgPools } = await import("@/test/pg-sql");
    await closePgPools();
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

  it("topic を差し替えると searchlight_stopped_at を消す（新しい topic はまだ止めていない）", async () => {
    await repo.upsertTenant({ ...rec, settings: { ...settings, searchlightTopicId: "t1" } });
    await repo.markSearchlightStopped("repo-test", 12345);
    await repo.upsertTenant({ ...rec, settings: { ...settings, searchlightTopicId: "t2" } });
    expect((await repo.getTenant("repo-test"))?.searchlightStoppedAt).toBeNull();
  });

  it("終了日を延ばすと消し、縮める・据え置きなら残す", async () => {
    await repo.upsertTenant(rec);
    await repo.markSearchlightStopped("repo-test", 12345);
    await repo.upsertTenant({ ...rec, settings: { ...settings, monitorEndDate: "2026-09-10" } });
    expect((await repo.getTenant("repo-test"))?.searchlightStoppedAt).toBe(12345);
    await repo.upsertTenant({ ...rec, settings: { ...settings, monitorEndDate: "2026-09-10" } });
    expect((await repo.getTenant("repo-test"))?.searchlightStoppedAt).toBe(12345);
    await repo.upsertTenant({ ...rec, settings: { ...settings, monitorEndDate: "2026-10-01" } });
    expect((await repo.getTenant("repo-test"))?.searchlightStoppedAt).toBeNull();
  });

  it("ended から戻すと消し、ended のままなら残す", async () => {
    await repo.upsertTenant({ ...rec, status: "ended" });
    await repo.markSearchlightStopped("repo-test", 12345);
    await repo.upsertTenant({ ...rec, status: "ended" });
    expect((await repo.getTenant("repo-test"))?.searchlightStoppedAt).toBe(12345);
    await repo.upsertTenant({ ...rec, status: "active" });
    expect((await repo.getTenant("repo-test"))?.searchlightStoppedAt).toBeNull();
  });

  it("行の slug と settings.slug が食い違う行は読み出しで例外", async () => {
    await repo.upsertTenant({ ...rec, settings: { ...settings, slug: "other" } });
    await expect(repo.getTenant("repo-test")).rejects.toThrow(/一致しません/);
  });

  it("appTitle・githubRepo・URL の制約は読み出しにもかかる", async () => {
    await repo.upsertTenant({ ...rec, settings: { ...settings, appTitle: "熊本" } });
    await expect(repo.getTenant("repo-test")).rejects.toThrow();
    await repo.upsertTenant({ ...rec, settings: { ...settings, issuesUrl: "javascript:alert(1)" } });
    await expect(repo.getTenant("repo-test")).rejects.toThrow();
  });

  it("listTenants に含まれる", async () => {
    await repo.upsertTenant(rec);
    const slugs = (await repo.listTenants()).map((t) => t.slug);
    expect(slugs).toContain("repo-test");
  });

  it("saveTenant: 新規は saved、同じ slug は exists で何も書かない", async () => {
    expect(await repo.saveTenant(rec, null)).toBe("saved");
    expect(await repo.saveTenant({ ...rec, status: "ended" }, null)).toBe("exists");
    const got = await repo.getTenant("repo-test");
    expect(got?.status).toBe("active");
    expect((await repo.listTenants()).filter((t) => t.slug === "repo-test")).toHaveLength(1);
  });

  it("saveTenant: updatedAt が一致したときだけ更新し、古い値は conflict", async () => {
    await repo.saveTenant(rec, null);
    const first = (await repo.getTenant("repo-test"))!.updatedAt;
    expect(await repo.saveTenant({ ...rec, overrides: { binMinutes: 10 } }, first)).toBe("saved");
    const second = (await repo.getTenant("repo-test"))!;
    expect(second.updatedAt).toBeGreaterThan(first);
    expect(await repo.saveTenant({ ...rec, overrides: { binMinutes: 99 } }, first)).toBe("conflict");
    expect((await repo.getTenant("repo-test"))?.overrides).toEqual({ binMinutes: 10 });
  });

  it("saveTenant: 同一ミリ秒の連続保存でも updatedAt は増える", async () => {
    await repo.saveTenant(rec, null);
    let at = (await repo.getTenant("repo-test"))!.updatedAt;
    for (let i = 0; i < 5; i++) {
      expect(await repo.saveTenant(rec, at)).toBe("saved");
      const next = (await repo.getTenant("repo-test"))!.updatedAt;
      expect(next).toBeGreaterThan(at);
      at = next;
    }
  });

  it("saveTenant: 存在しない slug への更新は conflict", async () => {
    expect(await repo.saveTenant(rec, 123)).toBe("conflict");
    expect(await repo.getTenant("repo-test")).toBeNull();
  });

  it("saveTenant: ended から戻すと searchlight_stopped_at を消す", async () => {
    await repo.upsertTenant({ ...rec, status: "ended" });
    await repo.markSearchlightStopped("repo-test", 12345);
    const at = (await repo.getTenant("repo-test"))!.updatedAt;
    expect(await repo.saveTenant({ ...rec, status: "active" }, at)).toBe("saved");
    expect((await repo.getTenant("repo-test"))?.searchlightStoppedAt).toBeNull();
  });

  it("listTenantsLenient: 壊れた行は error 付きで返し、他の行は読める", async () => {
    await repo.upsertTenant(rec);
    await db.sql()`delete from tenants where slug = 'repo-broken'`;
    await db.sql()`
      insert into tenants (slug, type, status, settings, overrides, updated_at)
      values ('repo-broken', 'disaster', 'active', '{"slug":"repo-broken"}'::jsonb, '{}'::jsonb, 1)`;
    try {
      const list = await repo.listTenantsLenient();
      const ok = list.find((i) => i.slug === "repo-test");
      const broken = list.find((i) => i.slug === "repo-broken");
      expect(ok?.record?.slug).toBe("repo-test");
      expect(broken?.record).toBeNull();
      expect(broken && "error" in broken ? broken.error.length : 0).toBeGreaterThan(0);
    } finally {
      await db.sql()`delete from tenants where slug = 'repo-broken'`;
    }
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
