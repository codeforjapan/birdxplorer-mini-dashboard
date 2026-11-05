import { describe, expect, it } from "vitest";
import { TENANT_INDEX_PATH, tenantPaths } from "./blob";

describe("tenantPaths", () => {
  it("事例ごとの接頭辞つきパスを返す", () => {
    const p = tenantPaths("kumamoto");
    expect(p.notes).toBe("tenants/kumamoto/data/notes.json");
    expect(p.timeline).toBe("tenants/kumamoto/data/timeline.json");
    expect(p.clusters).toBe("tenants/kumamoto/data/clusters.json");
    expect(p.crossPosts).toBe("tenants/kumamoto/data/cross-posts.json");
    expect(p.dailyReport("2026-08-01")).toBe("tenants/kumamoto/reports/daily/2026-08-01.md");
    expect(p.cumulativeReport).toBe("tenants/kumamoto/reports/cumulative.md");
    expect(p.config).toBe("tenants/kumamoto/config.json");
  });

  it("不正な slug は例外（パストラバーサル・大文字・端のハイフン）", () => {
    expect(() => tenantPaths("../x")).toThrow();
    expect(() => tenantPaths("A")).toThrow();
    expect(() => tenantPaths("-a")).toThrow();
    expect(() => tenantPaths("a-")).toThrow();
    expect(() => tenantPaths("")).toThrow();
  });

  it("1文字・ハイフン含みの slug は許す", () => {
    expect(() => tenantPaths("a")).not.toThrow();
    expect(() => tenantPaths("hyogo-2026")).not.toThrow();
  });

  it("事例一覧のパスは固定", () => {
    expect(TENANT_INDEX_PATH).toBe("tenants/index.json");
  });
});
