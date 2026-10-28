import { beforeEach, describe, expect, it, vi } from "vitest";
import disaster from "../../../tenants/examples/disaster.example.json";
import type { TenantInput } from "../tenant/input";
import type { TenantRecord, TenantStatus } from "../tenant/types";

const requireAdmin = vi.fn();
const saveTenant = vi.fn();
const getTenant = vi.fn();
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

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  for (const m of [requireAdmin, saveTenant, getTenant, publishTenant, migrate, revalidatePath]) m.mockReset();
  requireAdmin.mockResolvedValue({ email: "ok@x.org" });
  migrate.mockResolvedValue({ files: [] });
  saveTenant.mockResolvedValue("saved");
  publishTenant.mockResolvedValue(undefined);
  getTenant.mockResolvedValue(record({ updatedAt: 200 }));
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
  it("status は draft・topic は null で保存し、公開して成功を返す", async () => {
    getTenant.mockResolvedValue(record({ status: "draft", updatedAt: 300 }));
    const r = await createTenantAction(formValuesFromRecord(record({ status: "active" })));
    expect(r).toEqual({ ok: true, slug: SLUG, updatedAt: 300 });
    expect(migrate).toHaveBeenCalled();
    expect(saveTenant).toHaveBeenCalledWith(expect.anything(), null);
    expect(savedInput().status).toBe("draft");
    expect(savedInput().settings.searchlightTopicId).toBeNull();
    expect(publishTenant).toHaveBeenCalledTimes(1);
    expect(revalidatePath).toHaveBeenCalledWith("/admin");
    expect(revalidatePath).toHaveBeenCalledWith(`/admin/${SLUG}`);
  });

  it("既存 slug は exists で公開しない", async () => {
    saveTenant.mockResolvedValue("exists");
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
    expect(saveTenant).toHaveBeenCalled();
  });

  it("保存後の行が読めないまま失敗したら updatedAt は付けない", async () => {
    getTenant.mockRejectedValue(new Error("bad row"));
    const r = await createTenantAction(formValuesFromRecord(record()));
    expect(r).toMatchObject({ ok: false, kind: "publish-failed" });
    expect(r).not.toHaveProperty("updatedAt");
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
    saveTenant.mockResolvedValue("conflict");
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
    getTenant.mockResolvedValueOnce(record()).mockResolvedValueOnce(record({ updatedAt: 201 }));
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
      getTenant.mockResolvedValueOnce(existing).mockResolvedValueOnce({ ...existing, status: to, updatedAt: 101 });
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

  it("公開に失敗したら publish-failed", async () => {
    publishTenant.mockRejectedValue(new Error("blob down"));
    getTenant.mockResolvedValueOnce(record()).mockResolvedValueOnce(record({ status: "active", updatedAt: 202 }));
    await expect(changeTenantStatusAction(SLUG, "active", 100)).resolves.toMatchObject({
      kind: "publish-failed",
      updatedAt: 202,
    });
    expect(saveTenant).toHaveBeenCalled();
  });
});
