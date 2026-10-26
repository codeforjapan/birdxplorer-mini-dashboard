import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseTenantInput } from "./tenant-upsert";

function load(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(`tenants/examples/${name}.example.json`, "utf8")) as Record<string, unknown>;
}

function withSettings(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  return { ...base, settings: { ...(base.settings as Record<string, unknown>), ...patch } };
}

describe("parseTenantInput", () => {
  it("2つの example JSON が通る", () => {
    expect(parseTenantInput(load("disaster")).slug).toBe("kumamoto-example");
    expect(parseTenantInput(load("election")).type).toBe("election");
  });

  it("slug 規則に違反すると例外", () => {
    const base = load("disaster");
    expect(() => parseTenantInput({ ...base, slug: "Bad_Slug", settings: { ...(base.settings as object), slug: "Bad_Slug" } })).toThrow();
  });

  it("トップの slug と settings.slug が食い違うと例外", () => {
    expect(() => parseTenantInput(withSettings(load("disaster"), { slug: "other" }))).toThrow();
  });

  it("未知の type は例外", () => {
    expect(() => parseTenantInput({ ...load("disaster"), type: "festival" })).toThrow();
  });

  it("monitorEndDate が YYYY-MM-DD でないと例外", () => {
    expect(() => parseTenantInput(withSettings(load("disaster"), { monitorEndDate: "2026/08/31" }))).toThrow();
  });

  it("実在しない日付は例外", () => {
    expect(() => parseTenantInput(withSettings(load("disaster"), { monitorEndDate: "2026-02-30" }))).toThrow();
  });

  it("searchKeywords が空だと例外", () => {
    expect(() => parseTenantInput(withSettings(load("disaster"), { searchKeywords: [] }))).toThrow();
  });

  it("オブジェクト以外は例外", () => {
    expect(() => parseTenantInput(null)).toThrow();
  });
});
