import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { safeParseTenantInput } from "./input";

function load(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(`tenants/examples/${name}.example.json`, "utf8")) as Record<string, unknown>;
}

function withSettings(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  return { ...base, settings: { ...(base.settings as Record<string, unknown>), ...patch } };
}

describe("safeParseTenantInput", () => {
  it("example JSON が通る", () => {
    expect(safeParseTenantInput(load("disaster")).ok).toBe(true);
    expect(safeParseTenantInput(load("election")).ok).toBe(true);
  });

  it("違反はドット連結の path で返す", () => {
    const r = safeParseTenantInput(withSettings(load("disaster"), { appTitle: "熊本" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.map((i) => i.path)).toContain("settings.appTitle");
  });

  it("slug と settings.slug の不一致は settings.slug に出る", () => {
    const r = safeParseTenantInput({ ...withSettings(load("disaster"), { slug: "b" }), slug: "a" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.map((i) => i.path)).toContain("settings.slug");
  });

  it("終了日が開始日（JST）より前なら settings.monitorEndDate に出る", () => {
    // 開始 2026-07-28 13:00 JST
    const r = safeParseTenantInput(withSettings(load("disaster"), { monitorEndDate: "2026-07-27" }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const i = r.issues.find((x) => x.path === "settings.monitorEndDate");
      expect(i?.message).toBe("終了日は開始日以降にしてください");
    }
    expect(safeParseTenantInput(withSettings(load("disaster"), { monitorEndDate: "2026-07-28" })).ok).toBe(true);
  });

  it("違反のメッセージは日本語", () => {
    const r = safeParseTenantInput(
      withSettings(load("disaster"), {
        siteTitle: "",
        monitorStartAt: Number.NaN,
        monitorEndDate: "",
        searchKeywords: [],
        officialSources: [{ label: "", url: "javascript:alert(1)" }],
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const byPath = Object.fromEntries(r.issues.map((i) => [i.path, i.message]));
      expect(byPath["settings.siteTitle"]).toBe("入力してください");
      expect(byPath["settings.monitorStartAt"]).toBe("日時を入力してください");
      expect(byPath["settings.monitorEndDate"]).toBe("日付を入力してください");
      expect(byPath["settings.searchKeywords"]).toBe("1つ以上入力してください");
      expect(byPath["settings.officialSources.0.url"]).toBe("http(s) の URL を入力してください");
      for (const i of r.issues) expect(i.message).toMatch(/[ぁ-んァ-ヶ一-龠]/);
    }
  });
});
