import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TenantRecord, TenantSettings } from "./types";

const blob = vi.hoisted(() => ({
  put: vi.fn(async (pathname: string) => ({ url: `https://blob.example/${pathname}` })),
  list: vi.fn(async () => ({ blobs: [] as { pathname: string; url: string }[] })),
}));
vi.mock("@vercel/blob", () => blob);

const repo = vi.hoisted(() => ({ listTenants: vi.fn<() => Promise<TenantRecord[]>>() }));
vi.mock("./repo", () => repo);

import { publishTenant, readTenantIndex } from "./publish";

function settings(slug: string, searchlightTopicId: string | null): TenantSettings {
  return {
    slug,
    siteTitle: `${slug} タイトル`,
    siteDescription: "説明",
    eyebrowLabel: "eyebrow",
    scheduleLabel: "schedule",
    monitorStartAt: 1000,
    monitorEndDate: "2026-12-31",
    searchKeywords: ["テスト"],
    llmContextPhrase: "テスト",
    llmContextPhraseCompact: "テスト",
    llmContextPhraseShort: "テスト",
    keyMoments: [],
    keyMomentLabel: "",
    keyMomentValue: "",
    githubRepo: "owner/repo",
    appTitle: "app",
    issuesUrl: "https://example.com/issues",
    officialSourcesIntro: "",
    officialSources: [],
    officialSourcesDisclaimer: "",
    searchlightTopicId,
  };
}

function record(slug: string, over: Partial<TenantRecord> = {}): TenantRecord {
  return {
    slug,
    type: "disaster",
    status: "active",
    settings: settings(slug, null),
    overrides: {},
    searchlightStoppedAt: null,
    updatedAt: 0,
    ...over,
  };
}

function written(pathname: string): unknown {
  const call = blob.put.mock.calls.find((c) => c[0] === pathname) as unknown[] | undefined;
  if (!call) throw new Error(`${pathname} は書かれていない`);
  return JSON.parse(String(call[1]));
}

beforeEach(() => {
  vi.stubEnv("BLOB_READ_WRITE_TOKEN", "test-token");
  vi.stubEnv("DATABASE_URL", "postgres://unused");
  blob.put.mockClear();
  blob.list.mockClear();
});

describe("publishTenant", () => {
  it("公開設定を config.json に書き、taxonomy などの内部値を含めない", async () => {
    const rec = record("kumamoto", { settings: settings("kumamoto", "topic-1") });
    repo.listTenants.mockResolvedValue([rec]);

    await publishTenant(rec);

    const cfg = written("tenants/kumamoto/config.json") as Record<string, unknown>;
    expect(cfg.slug).toBe("kumamoto");
    expect(cfg.siteTitle).toBe("kumamoto タイトル");
    expect(cfg.hasSearchlight).toBe(true);
    expect(cfg).not.toHaveProperty("taxonomy");
    expect(cfg).not.toHaveProperty("searchKeywords");
    expect(cfg).not.toHaveProperty("searchlightTopicId");
  });

  it("index.json を全事例から作り直す", async () => {
    const a = record("a", { settings: settings("a", "t-a"), searchlightStoppedAt: 5 });
    const b = record("b", { status: "draft" });
    repo.listTenants.mockResolvedValue([a, b]);

    await publishTenant(b);

    expect(written("tenants/index.json")).toEqual([
      {
        slug: "a",
        status: "active",
        monitorStartAt: 1000,
        monitorEndDate: "2026-12-31",
        hasSearchlight: true,
        searchlightStopped: true,
      },
      {
        slug: "b",
        status: "draft",
        monitorStartAt: 1000,
        monitorEndDate: "2026-12-31",
        hasSearchlight: false,
        searchlightStopped: false,
      },
    ]);
  });
});

describe("readTenantIndex", () => {
  it("index.json が無ければ空", async () => {
    expect(await readTenantIndex()).toEqual([]);
  });
});
