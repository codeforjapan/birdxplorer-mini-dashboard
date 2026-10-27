import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseTenantInput, topicRemovalRefusal, unreadableExistingRefusal } from "./tenant-upsert";
import type { TenantInput } from "./tenant-upsert";

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

  it("appTitle は印字可能な ASCII だけ（X-Title ヘッダに入るため）", () => {
    for (const appTitle of ["熊本ダッシュボード", "a\nb", ""]) {
      expect(() => parseTenantInput(withSettings(load("disaster"), { appTitle }))).toThrow();
    }
    expect(parseTenantInput(withSettings(load("disaster"), { appTitle: "My App (v2)" })).settings.appTitle).toBe(
      "My App (v2)",
    );
  });

  it("githubRepo は owner/repo の形だけ", () => {
    for (const githubRepo of ["repo", "a/b/c", "https://github.com/a/b", "a/b?x=1", ""]) {
      expect(() => parseTenantInput(withSettings(load("disaster"), { githubRepo }))).toThrow();
    }
  });

  it("issuesUrl・officialSources の URL は http(s) だけ", () => {
    for (const url of ["javascript:alert(1)", "ftp://example.com", "not a url"]) {
      expect(() => parseTenantInput(withSettings(load("disaster"), { issuesUrl: url }))).toThrow();
      expect(() =>
        parseTenantInput(withSettings(load("disaster"), { officialSources: [{ label: "公式", url }] })),
      ).toThrow();
    }
    expect(() => parseTenantInput(withSettings(load("disaster"), { issuesUrl: "http://example.com/i" }))).not.toThrow();
  });
});

describe("topicRemovalRefusal", () => {
  const input = (topic: string | null): TenantInput => {
    const base = parseTenantInput(load("disaster"));
    return { ...base, settings: { ...base.settings, searchlightTopicId: topic } };
  };
  const existing = (topic: string | null, stoppedAt: number | null) => ({
    settings: input(topic).settings,
    searchlightStoppedAt: stoppedAt,
  });

  it("新規・topic 不変・元が null なら通す", () => {
    expect(topicRemovalRefusal(null, input("t1"), false)).toBeNull();
    expect(topicRemovalRefusal(existing("t1", null), input("t1"), false)).toBeNull();
    expect(topicRemovalRefusal(existing(null, null), input("t1"), false)).toBeNull();
  });

  it("停止の記録が無いまま topic を外す・差し替えるのは拒否する", () => {
    expect(topicRemovalRefusal(existing("t1", null), input(null), false)).toContain("searchlight-stop");
    expect(topicRemovalRefusal(existing("t1", null), input("t2"), false)).toContain("t1");
    // 誤記で一覧に無い topic は searchlight-stop が記録できないので、フラグで差し替える道を示す
    expect(topicRemovalRefusal(existing("typo", null), input("t2"), false)).toMatch(/誤記[\s\S]*--topic-stopped-in-searchlight/);
  });

  it("停止済みの記録があるか、Searchlight で止めたと明示すれば通す", () => {
    expect(topicRemovalRefusal(existing("t1", 123), input(null), false)).toBeNull();
    expect(topicRemovalRefusal(existing("t1", null), input(null), true)).toBeNull();
  });
});

describe("unreadableExistingRefusal", () => {
  it("既存行が読めなければ拒否し、理由に読めなかった原因とフラグを含める", () => {
    const msg = unreadableExistingRefusal(new Error("appTitle が不正"), false);
    expect(msg).toContain("appTitle が不正");
    expect(msg).toContain("--topic-stopped-in-searchlight");
  });

  it("Searchlight で止めたと明示すれば通す（行を上書きして直す）", () => {
    expect(unreadableExistingRefusal(new Error("x"), true)).toBeNull();
  });
});
