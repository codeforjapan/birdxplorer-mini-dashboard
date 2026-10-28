import { beforeEach, describe, expect, it, vi } from "vitest";
import disaster from "../../../tenants/examples/disaster.example.json";
import type { TenantInput } from "../tenant/input";
import type { TenantRecord, TenantStatus } from "../tenant/types";

const requireAdmin = vi.fn();
const saveTenant = vi.fn();
const getTenant = vi.fn();
const listTenantsLenient = vi.fn();
const publishTenant = vi.fn();
const migrate = vi.fn();
const revalidatePath = vi.fn();

vi.mock("@/lib/admin/session", () => ({
  AdminAuthError: class AdminAuthError extends Error {},
  requireAdmin: () => requireAdmin(),
}));
vi.mock("@/lib/tenant/repo", () => ({
  saveTenant: (...a: unknown[]) => saveTenant(...a),
  getTenant: (...a: unknown[]) => getTenant(...a),
  listTenantsLenient: () => listTenantsLenient(),
}));
vi.mock("@/lib/tenant/publish", () => ({ publishTenant: (...a: unknown[]) => publishTenant(...a) }));
vi.mock("@/lib/db", () => ({ migrate: () => migrate() }));
vi.mock("next/cache", () => ({ revalidatePath: (...a: unknown[]) => revalidatePath(...a) }));

import { AdminAuthError } from "@/lib/admin/session";
import { changeTenantStatusAction, createTenantAction, updateTenantAction } from "./actions";
import { formValuesFromRecord } from "./form";

const SLUG = "kumamoto-example";

function record(over: Partial<TenantRecord> = {}): TenantRecord {
  const base = disaster as unknown as Omit<TenantRecord, "updatedAt" | "searchlightStoppedAt">;
  return { ...base, searchlightStoppedAt: null, updatedAt: 100, ...over };
}

function savedInput(): TenantInput {
  return saveTenant.mock.calls[0][0] as TenantInput;
}

// 実物の saveTenant と同じく、書いた行（入力 + DB が決めた updatedAt）を返す
function savesAs(updatedAt: number, searchlightStoppedAt: number | null = null) {
  saveTenant.mockImplementation(async (input: TenantInput) => ({
    result: "saved",
    record: { ...input, searchlightStoppedAt, updatedAt },
  }));
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  for (const m of [requireAdmin, saveTenant, getTenant, listTenantsLenient, publishTenant, migrate, revalidatePath]) {
    m.mockReset();
  }
  requireAdmin.mockResolvedValue({ email: "ok@x.org" });
  migrate.mockResolvedValue({ files: [] });
  savesAs(200);
  publishTenant.mockResolvedValue(undefined);
  getTenant.mockResolvedValue(record());
  listTenantsLenient.mockResolvedValue([]);
});

describe("認可", () => {
  const calls: [string, () => Promise<unknown>][] = [
    ["create", () => createTenantAction(formValuesFromRecord(record()))],
    ["update", () => updateTenantAction(SLUG, formValuesFromRecord(record()), 100)],
    ["status", () => changeTenantStatusAction(SLUG, "ended", 100)],
  ];
  for (const [name, call] of calls) {
    it(`${name}: 未許可なら何も読まずに unauthorized`, async () => {
      requireAdmin.mockRejectedValue(new AdminAuthError("ng"));
      await expect(call()).resolves.toMatchObject({ ok: false, kind: "unauthorized" });
      expect(migrate).not.toHaveBeenCalled();
      expect(getTenant).not.toHaveBeenCalled();
      expect(saveTenant).not.toHaveBeenCalled();
      expect(publishTenant).not.toHaveBeenCalled();
    });
  }
});

describe("createTenantAction", () => {
  it("status は draft・topic は null で保存し、書いた行をそのまま公開して成功を返す", async () => {
    savesAs(300);
    const r = await createTenantAction(formValuesFromRecord(record({ status: "active" })));
    expect(r).toEqual({ ok: true, slug: SLUG, updatedAt: 300 });
    expect(getTenant).not.toHaveBeenCalled();
    expect(publishTenant).toHaveBeenCalledWith({ ...savedInput(), searchlightStoppedAt: null, updatedAt: 300 });
    expect(migrate).toHaveBeenCalled();
    expect(saveTenant).toHaveBeenCalledWith(expect.anything(), null);
    expect(savedInput().status).toBe("draft");
    expect(savedInput().settings.searchlightTopicId).toBeNull();
    expect(publishTenant).toHaveBeenCalledTimes(1);
    expect(revalidatePath).toHaveBeenCalledWith("/admin");
    expect(revalidatePath).toHaveBeenCalledWith(`/admin/${SLUG}`);
  });

  it("既存 slug は exists で公開しない", async () => {
    saveTenant.mockResolvedValue({ result: "exists" });
    const r = await createTenantAction(formValuesFromRecord(record()));
    expect(r).toMatchObject({ ok: false, kind: "exists" });
    expect(publishTenant).not.toHaveBeenCalled();
  });

  it("不正値は invalid で欄ごとのエラーを返す", async () => {
    const v = { ...formValuesFromRecord(record()), appTitle: "熊本" };
    const r = await createTenantAction(v);
    expect(r).toMatchObject({ ok: false, kind: "invalid" });
    expect(r.ok === false && r.fieldErrors?.appTitle).toBeTruthy();
    expect(saveTenant).not.toHaveBeenCalled();
  });

  it("形の崩れた値は例外にせず invalid", async () => {
    for (const bad of [{}, null, "x", { ...formValuesFromRecord(record()), taxonomy: undefined }]) {
      const r = await createTenantAction(bad as never);
      expect(r).toMatchObject({ ok: false, kind: "invalid" });
    }
    expect(saveTenant).not.toHaveBeenCalled();
  });

  it("公開に失敗したら publish-failed（DB には保存済み）", async () => {
    publishTenant.mockRejectedValue(new Error("blob down"));
    const r = await createTenantAction(formValuesFromRecord(record()));
    expect(r).toMatchObject({ ok: false, kind: "publish-failed", updatedAt: 200 });
    expect(r.ok === false && r.message).toContain("もう一度");
    expect(saveTenant).toHaveBeenCalled();
  });

  it("読めない事例があって公開できないときは、その slug と tenant-upsert を示し再保存を勧めない", async () => {
    publishTenant.mockRejectedValue(new Error("bad row"));
    listTenantsLenient.mockResolvedValue([
      { slug: "broken-a", record: null, error: "x" },
      { slug: SLUG, record: record() },
      { slug: "broken-b", record: null, error: "y" },
    ]);
    const r = await createTenantAction(formValuesFromRecord(record()));
    expect(r).toMatchObject({ ok: false, kind: "publish-failed", updatedAt: 200 });
    const message = r.ok === false ? r.message : "";
    expect(message).toContain("broken-a");
    expect(message).toContain("broken-b");
    expect(message).toContain("tenant-upsert");
    expect(message).not.toContain("もう一度");
  });

  it("読めない事例の確認自体が失敗しても publish-failed を返す", async () => {
    publishTenant.mockRejectedValue(new Error("blob down"));
    listTenantsLenient.mockRejectedValue(new Error("db down"));
    await expect(createTenantAction(formValuesFromRecord(record()))).resolves.toMatchObject({
      ok: false,
      kind: "publish-failed",
      updatedAt: 200,
    });
  });

  it("DB の失敗は error", async () => {
    saveTenant.mockRejectedValue(new Error("db down"));
    await expect(createTenantAction(formValuesFromRecord(record()))).resolves.toMatchObject({
      ok: false,
      kind: "error",
    });
  });
});

describe("updateTenantAction", () => {
  it("status と topic はフォームに関係なく既存の値を保つ", async () => {
    getTenant.mockResolvedValue(
      record({ status: "active", settings: { ...record().settings, searchlightTopicId: "t1" } }),
    );
    const r = await updateTenantAction(SLUG, formValuesFromRecord(record({ status: "draft" })), 100);
    expect(r).toMatchObject({ ok: true, slug: SLUG });
    expect(saveTenant).toHaveBeenCalledWith(expect.anything(), 100);
    expect(savedInput().status).toBe("active");
    expect(savedInput().settings.searchlightTopicId).toBe("t1");
  });

  it("引数の slug とフォームの slug が違えば invalid", async () => {
    const v = { ...formValuesFromRecord(record()), slug: "other" };
    await expect(updateTenantAction(SLUG, v, 100)).resolves.toMatchObject({ ok: false, kind: "invalid" });
    expect(saveTenant).not.toHaveBeenCalled();
  });

  it("不正な slug や updatedAt は invalid", async () => {
    const v = formValuesFromRecord(record());
    await expect(updateTenantAction("../x", { ...v, slug: "../x" }, 100)).resolves.toMatchObject({
      kind: "invalid",
    });
    await expect(updateTenantAction(SLUG, v, null as never)).resolves.toMatchObject({ kind: "invalid" });
    expect(getTenant).not.toHaveBeenCalled();
    expect(saveTenant).not.toHaveBeenCalled();
  });

  it("conflict を返す", async () => {
    saveTenant.mockResolvedValue({ result: "conflict" });
    await expect(updateTenantAction(SLUG, formValuesFromRecord(record()), 100)).resolves.toMatchObject({
      ok: false,
      kind: "conflict",
    });
    expect(publishTenant).not.toHaveBeenCalled();
  });

  it("既存行が読めなければ unreadable", async () => {
    getTenant.mockRejectedValue(new Error("bad row"));
    const r = await updateTenantAction(SLUG, formValuesFromRecord(record()), 100);
    expect(r).toMatchObject({ ok: false, kind: "unreadable" });
    expect(r.ok === false && r.message).toContain("tenant-upsert");
    expect(saveTenant).not.toHaveBeenCalled();
  });

  it("公開に失敗したら publish-failed", async () => {
    publishTenant.mockRejectedValue(new Error("blob down"));
    savesAs(201);
    await expect(updateTenantAction(SLUG, formValuesFromRecord(record()), 100)).resolves.toMatchObject({
      kind: "publish-failed",
      updatedAt: 201,
    });
    expect(saveTenant).toHaveBeenCalled();
  });
});

describe("changeTenantStatusAction", () => {
  const transitions: [TenantStatus, TenantStatus][] = [
    ["draft", "active"],
    ["active", "draft"],
    ["ended", "draft"],
    ["draft", "ended"],
  ];
  for (const [from, to] of transitions) {
    it(`${from} → ${to} は成功し、settings・overrides はそのまま`, async () => {
      const existing = record({ status: from, overrides: { binMinutes: 60 } });
      getTenant.mockResolvedValue(existing);
      savesAs(101);
      const r = await changeTenantStatusAction(SLUG, to, 100);
      expect(r).toEqual({ ok: true, slug: SLUG, updatedAt: 101 });
      expect(saveTenant).toHaveBeenCalledWith(
        { slug: SLUG, type: existing.type, status: to, settings: existing.settings, overrides: existing.overrides },
        100,
      );
      expect(publishTenant).toHaveBeenCalled();
    });
  }

  it("不正な状態は invalid", async () => {
    await expect(changeTenantStatusAction(SLUG, "deleted" as never, 100)).resolves.toMatchObject({
      kind: "invalid",
    });
    expect(saveTenant).not.toHaveBeenCalled();
  });

  it("既存行が読めなければ unreadable", async () => {
    getTenant.mockRejectedValue(new Error("bad row"));
    await expect(changeTenantStatusAction(SLUG, "active", 100)).resolves.toMatchObject({ kind: "unreadable" });
  });

  it("保存済みの設定が入力の検証を通らなければ invalid で、編集画面へ案内し保存しない", async () => {
    // 読み出しの検証は通るが、入力の検証（空のタイトル不可）は通らない行
    getTenant.mockResolvedValue(record({ settings: { ...record().settings, siteTitle: "" } }));
    const r = await changeTenantStatusAction(SLUG, "active", 100);
    expect(r).toMatchObject({ ok: false, kind: "invalid" });
    expect(r.ok === false && r.message).toContain("編集");
    expect(saveTenant).not.toHaveBeenCalled();
    expect(publishTenant).not.toHaveBeenCalled();
  });

  it("公開に失敗したら publish-failed", async () => {
    publishTenant.mockRejectedValue(new Error("blob down"));
    savesAs(202);
    await expect(changeTenantStatusAction(SLUG, "active", 100)).resolves.toMatchObject({
      kind: "publish-failed",
      updatedAt: 202,
    });
    expect(saveTenant).toHaveBeenCalled();
  });
});
