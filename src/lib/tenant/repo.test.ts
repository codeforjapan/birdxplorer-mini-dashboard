import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { TenantRecord, TenantSettings } from "./types";

const settings: TenantSettings = {
  slug: "repo-test",
  hostLabel: "repo-test",
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
    const saved = await repo.saveTenant(rec, null);
    expect(saved.result).toBe("saved");
    expect(await repo.saveTenant({ ...rec, status: "ended" }, null)).toEqual({ result: "exists" });
    const got = await repo.getTenant("repo-test");
    expect(got?.status).toBe("active");
    expect(saved.result === "saved" && saved.record).toEqual(got);
    expect((await repo.listTenants()).filter((t) => t.slug === "repo-test")).toHaveLength(1);
  });

  it("saveTenant: updatedAt が一致したときだけ更新し、古い値は conflict", async () => {
    await repo.saveTenant(rec, null);
    const first = (await repo.getTenant("repo-test"))!.updatedAt;
    const saved = await repo.saveTenant({ ...rec, overrides: { binMinutes: 10 } }, first);
    const second = (await repo.getTenant("repo-test"))!;
    expect(saved).toEqual({ result: "saved", record: second });
    expect(second.updatedAt).toBeGreaterThan(first);
    expect(await repo.saveTenant({ ...rec, overrides: { binMinutes: 99 } }, first)).toEqual({ result: "conflict" });
    expect((await repo.getTenant("repo-test"))?.overrides).toEqual({ binMinutes: 10 });
  });

  it("saveTenant: 同一ミリ秒の連続保存でも updatedAt は増え、返す値は DB の値", async () => {
    await repo.saveTenant(rec, null);
    let at = (await repo.getTenant("repo-test"))!.updatedAt;
    for (let i = 0; i < 5; i++) {
      const saved = await repo.saveTenant(rec, at);
      const next = (await repo.getTenant("repo-test"))!.updatedAt;
      expect(saved.result === "saved" && saved.record.updatedAt).toBe(next);
      expect(next).toBeGreaterThan(at);
      at = next;
    }
  });

  it("saveTenant: 存在しない slug への更新は conflict", async () => {
    expect(await repo.saveTenant(rec, 123)).toEqual({ result: "conflict" });
    expect(await repo.getTenant("repo-test")).toBeNull();
  });

  it("saveTenant: ended から戻すと searchlight_stopped_at を消し、返す record にも反映する", async () => {
    await repo.upsertTenant({ ...rec, status: "ended" });
    await repo.markSearchlightStopped("repo-test", 12345);
    const at = (await repo.getTenant("repo-test"))!.updatedAt;
    const saved = await repo.saveTenant({ ...rec, status: "active" }, at);
    expect(saved.result === "saved" && saved.record.searchlightStoppedAt).toBeNull();
    expect((await repo.getTenant("repo-test"))?.searchlightStoppedAt).toBeNull();
  });

  it("saveTenant: 停止記録を保つ保存では返す record にも残る", async () => {
    await repo.upsertTenant(rec);
    await repo.markSearchlightStopped("repo-test", 12345);
    const at = (await repo.getTenant("repo-test"))!.updatedAt;
    const saved = await repo.saveTenant({ ...rec, overrides: { binMinutes: 10 } }, at);
    expect(saved.result === "saved" && saved.record.searchlightStoppedAt).toBe(12345);
  });

  // 時計の戻りや同一ミリ秒でも、画面が開いた時点の値と再び一致して後勝ちになるのを防ぐ
  it("upsertTenant・markSearchlightStopped も updatedAt を必ず増やす", async () => {
    await repo.upsertTenant(rec);
    const future = Date.now() + 10_000_000;
    await db.sql()`update tenants set updated_at = ${future} where slug = 'repo-test'`;
    await repo.upsertTenant({ ...rec, overrides: { binMinutes: 10 } });
    const afterUpsert = (await repo.getTenant("repo-test"))!.updatedAt;
    expect(afterUpsert).toBeGreaterThan(future);
    await repo.markSearchlightStopped("repo-test", 12345);
    expect((await repo.getTenant("repo-test"))!.updatedAt).toBeGreaterThan(afterUpsert);
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

  it("saveTenant: 他の事例と同じホスト名ラベルは label-taken で何も書かない", async () => {
    await db.sql()`delete from tenants where slug = 'repo-other'`;
    const other = { ...rec, slug: "repo-other", settings: { ...settings, slug: "repo-other", hostLabel: "repo-label" } };
    try {
      expect((await repo.saveTenant(other, null)).result).toBe("saved");
      // 新規
      const mine = { ...rec, settings: { ...settings, hostLabel: "repo-label" } };
      expect(await repo.saveTenant(mine, null)).toEqual({ result: "label-taken" });
      expect(await repo.getTenant("repo-test")).toBeNull();
      // 更新
      await repo.saveTenant(rec, null);
      const at = (await repo.getTenant("repo-test"))!.updatedAt;
      expect(await repo.saveTenant(mine, at)).toEqual({ result: "label-taken" });
      expect((await repo.getTenant("repo-test"))?.settings.hostLabel).toBe("repo-test");
      // 空いたラベルは使える
      const freed = { ...other, settings: { ...other.settings, hostLabel: "repo-other" } };
      await repo.saveTenant(freed, (await repo.getTenant("repo-other"))!.updatedAt);
      expect((await repo.saveTenant(mine, at)).result).toBe("saved");
    } finally {
      await db.sql()`delete from tenants where slug = 'repo-other'`;
    }
  });

  it("rekeyTenant: データを新しい slug に写し、古い行を消し、ラベルは引き継ぐ", async () => {
    const cleanup = async () => {
      for (const slug of ["repo-test", "repo-new"]) {
        await db.sql()`delete from notes where tenant_id = ${slug}`;
        await db.sql()`delete from job_runs where tenant_id = ${slug}`;
        await db.sql()`delete from clusters where tenant_id = ${slug}`;
        await db.sql()`delete from tenants where slug = ${slug}`;
      }
    };
    await cleanup();
    try {
      await repo.upsertTenant({ ...rec, settings: { ...settings, hostLabel: "repo-label" } });
      await repo.markSearchlightStopped("repo-test", 12345);
      await db.sql()`
        insert into clusters (tenant_id, id, name, description, color_index, created_at, alias_of) values
        ('repo-test', 'c_001', 'A', '', 0, 1, null), ('repo-test', 'c_002', 'B', '', 1, 2, 'c_001')`;
      await db.sql()`
        insert into notes (tenant_id, note_id, post_id, created_at, summary, post_url, status_refreshed_at,
          relevance, excluded, cluster_id, classified_at, classifier_version)
        values ('repo-test', 'n1', 'p1', 1, 's', 'u', 1, 80, false, 'c_002', 1, 'v')`;
      await db.sql()`
        insert into job_runs (tenant_id, job, started_at, finished_at, ok, stats)
        values ('repo-test', 'ingest', 1, 2, true, '{}'::jsonb)`;
      const before = await repo.countTenantData("repo-test");

      await db.sql()`update tenants set status = 'draft' where slug = 'repo-test'`;
      await repo.rekeyTenant("repo-test", "repo-new", Date.now() + 10_000_000);

      expect(await repo.getTenant("repo-test")).toBeNull();
      const moved = await repo.getTenant("repo-new");
      expect(moved?.settings.slug).toBe("repo-new");
      expect(moved?.settings.hostLabel).toBe("repo-label");
      expect(moved?.searchlightStoppedAt).toBe(12345);
      expect(await repo.countTenantData("repo-new")).toEqual(before);
      expect(Object.values(await repo.countTenantData("repo-test")).every((n) => n === 0)).toBe(true);
      const [note] = await db.sql()`select cluster_id from notes where tenant_id = 'repo-new'`;
      expect(note?.cluster_id).toBe("c_002");
    } finally {
      await cleanup();
    }
  });

  it("rekeyTenant: 途中で失敗したら何も変えない", async () => {
    await repo.upsertTenant(rec);
    await db.sql()`delete from tenants where slug = 'repo-taken'`;
    await repo.upsertTenant({ ...rec, slug: "repo-taken", settings: { ...settings, slug: "repo-taken", hostLabel: "repo-taken" } });
    try {
      await db.sql()`update tenants set status = 'draft' where slug = 'repo-test'`;
      await expect(repo.rekeyTenant("repo-test", "repo-taken", Date.now() + 10_000_000)).rejects.toThrow();
      expect((await repo.getTenant("repo-test"))?.settings.hostLabel).toBe("repo-test");
    } finally {
      await db.sql()`delete from tenants where slug = 'repo-taken'`;
    }
  });

  it("rekeyTenant: 下書きでない・quietBefore より後に変わった事例は何も変えない", async () => {
    await repo.upsertTenant(rec);
    await expect(repo.rekeyTenant("repo-test", "repo-new", Date.now() + 10_000_000)).rejects.toThrow();
    await db.sql()`update tenants set status = 'draft' where slug = 'repo-test'`;
    await expect(repo.rekeyTenant("repo-test", "repo-new", 0)).rejects.toThrow();
    expect(await repo.getTenant("repo-test")).not.toBeNull();
    expect(await repo.getTenant("repo-new")).toBeNull();
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
