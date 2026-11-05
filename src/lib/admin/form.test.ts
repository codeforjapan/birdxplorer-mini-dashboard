import { describe, expect, it } from "vitest";
import disaster from "../../../tenants/examples/disaster.example.json";
import election from "../../../tenants/examples/election.example.json";
import { TENANT_PRESETS } from "../tenant/presets";
import type { TenantRecord } from "../tenant/types";
import {
  fieldErrors,
  formValuesFromRecord,
  isPresetValue,
  newFormValues,
  toTenantInput,
} from "./form";

const base = { status: "draft" as const, searchlightTopicId: null };

// example は新規作成用で slug を持たないので、既存の事例として足す
function asRecord(j: unknown): TenantRecord {
  const rec = j as Omit<TenantRecord, "updatedAt" | "searchlightStoppedAt">;
  const slug = "example";
  return { ...rec, slug, settings: { ...rec.settings, slug }, searchlightStoppedAt: null, updatedAt: 1 };
}

describe("newFormValues / toTenantInput", () => {
  it("初期値のままなら overrides は空", () => {
    expect(toTenantInput(newFormValues("disaster"), base).overrides).toEqual({});
    expect(toTenantInput(newFormValues("election"), base).overrides).toEqual({});
  });

  it("初期値に既定の GitHub 項目が入る", () => {
    const v = newFormValues("disaster");
    expect(v.githubRepo).toBe("codeforjapan/birdxplorer-mini-dashboard");
    expect(v.appTitle).toBe("birdxplorer-mini-dashboard");
    expect(v.issuesUrl).toBe("https://github.com/codeforjapan/birdxplorer-mini-dashboard/issues");
  });

  it("taxonomy は変えた項目だけ overrides に入る", () => {
    const v = newFormValues("disaster");
    v.taxonomy.relevantExamples = "独自の例";
    expect(toTenantInput(v, base).overrides).toEqual({ taxonomy: { relevantExamples: "独自の例" } });
  });

  it("関連性・binMinutes も既定と違うときだけ入る", () => {
    const v = newFormValues("disaster");
    v.relevanceMode = "binary";
    v.relevanceThreshold = 70;
    v.binMinutes = 60;
    expect(toTenantInput(v, base).overrides).toEqual({
      relevanceMode: "binary",
      relevanceThreshold: 70,
      binMinutes: 60,
    });
  });

  it("空の taxonomy 項目は上書きなし（resolve と同じ意味）", () => {
    const v = newFormValues("disaster");
    v.taxonomy.relevantExamples = "  ";
    v.taxonomy.searchTermExamples = "";
    expect(toTenantInput(v, base).overrides).toEqual({});
  });

  it("searchKeywords は空行を捨てて trim", () => {
    const v = newFormValues("disaster");
    v.searchKeywords = "熊本\n\n 地震 \n";
    expect(toTenantInput(v, base).settings.searchKeywords).toEqual(["熊本", "地震"]);
  });

  it("searchKeywords の重複は最初の1つだけ残す", () => {
    const v = newFormValues("disaster");
    v.searchKeywords = "熊本\n地震\n 熊本 ";
    expect(toTenantInput(v, base).settings.searchKeywords).toEqual(["熊本", "地震"]);
  });

  it("searchlightTopicId と status は base から", () => {
    const r = toTenantInput(newFormValues("disaster"), { status: "active", searchlightTopicId: "t1" });
    expect(r.settings.searchlightTopicId).toBe("t1");
    expect(r.status).toBe("active");
  });

  it("slug は settings.slug にも入る", () => {
    const v = newFormValues("disaster");
    v.slug = "abc";
    const r = toTenantInput(v, base);
    expect([r.slug, r.settings.slug]).toEqual(["abc", "abc"]);
  });
});

describe("formValuesFromRecord", () => {
  it.each([
    ["disaster", disaster],
    ["election", election],
  ])("%s の例 JSON は往復で変わらない", (_n, j) => {
    const rec = asRecord(j);
    const out = toTenantInput(formValuesFromRecord(rec), {
      status: rec.status,
      searchlightTopicId: rec.settings.searchlightTopicId,
    });
    expect(out.settings).toEqual(rec.settings);
    expect(out.overrides).toEqual(rec.overrides);
    expect(out.slug).toBe(rec.slug);
    expect(out.type).toBe(rec.type);
  });

  it("overrides を型の既定に重ねた有効値になり、往復しても保たれる", () => {
    const rec = asRecord(disaster);
    rec.overrides = { binMinutes: 60, taxonomy: { relevantExamples: "X" } };
    const v = formValuesFromRecord(rec);
    expect(v.binMinutes).toBe(60);
    expect(v.taxonomy.relevantExamples).toBe("X");
    expect(v.taxonomy.searchTermExamples).toBe(TENANT_PRESETS.disaster.taxonomy.searchTermExamples);
    expect(toTenantInput(v, base).overrides).toEqual(rec.overrides);
  });

  it("monitorStartAt と keyMoments.at は JST 文字列", () => {
    const v = formValuesFromRecord(asRecord(disaster));
    expect(v.monitorStartAt).toBe("2026-07-28T13:00");
    expect(v.keyMoments[0].at).toBe("2026-07-28T16:27");
    expect(v.searchKeywords.split("\n")[0]).toBe("熊本");
  });
});

describe("JST 変換", () => {
  it("1785211200000 <-> 2026-07-28T13:00", () => {
    const v = newFormValues("disaster");
    v.monitorStartAt = "2026-07-28T13:00";
    expect(toTenantInput(v, base).settings.monitorStartAt).toBe(1785211200000);
  });

  it("不正な日時は NaN になり検証で弾かれる", () => {
    const v = newFormValues("disaster");
    v.monitorStartAt = "";
    expect(Number.isNaN(toTenantInput(v, base).settings.monitorStartAt)).toBe(true);
  });
});

describe("isPresetValue", () => {
  it("既定のままなら true、変えたら false", () => {
    const v = newFormValues("election");
    expect(isPresetValue(v, "namingNeutralityRule")).toBe(true);
    v.taxonomy.namingNeutralityRule = "別";
    expect(isPresetValue(v, "namingNeutralityRule")).toBe(false);
  });
});

describe("fieldErrors", () => {
  it("パスをフォームの欄名に寄せる", () => {
    expect(
      fieldErrors([
        { path: "settings.siteTitle", message: "a" },
        { path: "overrides.taxonomy.relevantExamples", message: "b" },
        { path: "settings.keyMoments.0.at", message: "c" },
        { path: "slug", message: "d" },
        { path: "", message: "e" },
      ]),
    ).toEqual({
      siteTitle: "a",
      "taxonomy.relevantExamples": "b",
      "keyMoments.0.at": "c",
      slug: "d",
      _form: "e",
    });
  });

  it("同じ欄は最初のメッセージを残す", () => {
    expect(
      fieldErrors([
        { path: "settings.slug", message: "first" },
        { path: "slug", message: "second" },
      ]),
    ).toEqual({ slug: "first" });
  });
});
