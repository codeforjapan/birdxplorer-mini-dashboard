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
});
