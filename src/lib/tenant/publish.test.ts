import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TenantRecord, TenantSettings } from "./types";

const blob = vi.hoisted(() => ({
  put: vi.fn(async (pathname: string) => ({ url: `https://blob.example/${pathname}` })),
  list: vi.fn(async () => ({ blobs: [] as { pathname: string; url: string }[] })),
}));
vi.mock("@vercel/blob", () => blob);

const repo = vi.hoisted(() => ({ listTenants: vi.fn<() => Promise<TenantRecord[]>>() }));
vi.mock("./repo", () => repo);

import { publishTenant, readPublicConfig, readTenantIndex } from "./publish";
import { resolveTenantConfig, toPublicConfig } from "./resolve";

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
  blob.list.mockImplementation(async () => ({ blobs: [] }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** pathname が Blob にあることにして、その本文の取得を respond で返す */
function serve(pathname: string, respond: () => Promise<Response>): void {
  blob.list.mockImplementation(async () => ({ blobs: [{ pathname, url: `https://blob.example/${pathname}` }] }));
  vi.stubGlobal("fetch", vi.fn(respond));
}

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
  it("index.json が無ければ例外（空として扱うと全事例の cron が黙って止まる）", async () => {
    await expect(readTenantIndex()).rejects.toThrow(/index\.json/);
  });

  it("HTTP エラー・通信失敗は例外", async () => {
    serve("tenants/index.json", async () => new Response("", { status: 503 }));
    await expect(readTenantIndex()).rejects.toThrow(/HTTP 503/);
    serve("tenants/index.json", async () => {
      throw new Error("network");
    });
    await expect(readTenantIndex()).rejects.toThrow("network");
  });

  it("壊れた中身は例外", async () => {
    serve("tenants/index.json", async () => new Response("[{\"slug\":1}]"));
    await expect(readTenantIndex()).rejects.toThrow();
  });

  it("正しい index は読める", async () => {
    const entry = {
      slug: "a",
      status: "active",
      monitorStartAt: 1,
      monitorEndDate: "2026-12-31",
      hasSearchlight: false,
      searchlightStopped: false,
    };
    serve("tenants/index.json", async () => new Response(JSON.stringify([entry])));
    expect(await readTenantIndex()).toEqual([entry]);
  });
});

describe("readPublicConfig", () => {
  const path = "tenants/kumamoto/config.json";
  const pub = toPublicConfig(resolveTenantConfig(record("kumamoto")));

  it("slug の形式違反・無い・HTTP 404 は null（404 ページ）", async () => {
    expect(await readPublicConfig("../x")).toBeNull();
    expect(await readPublicConfig("kumamoto")).toBeNull();
    serve(path, async () => new Response("", { status: 404 }));
    expect(await readPublicConfig("kumamoto")).toBeNull();
  });

  it("正しい設定は読める", async () => {
    serve(path, async () => new Response(JSON.stringify(pub)));
    expect(await readPublicConfig("kumamoto")).toEqual(pub);
  });

  it("読み取り失敗は null ではなく例外（404 を ISR にキャッシュさせない）", async () => {
    serve(path, async () => new Response("", { status: 500 }));
    await expect(readPublicConfig("kumamoto")).rejects.toThrow(/HTTP 500/);
  });

  it("JSON・形の破損はログに出して例外", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    serve(path, async () => new Response("{not json"));
    await expect(readPublicConfig("kumamoto")).rejects.toThrow();
    serve(path, async () => new Response(JSON.stringify({ ...pub, binMinutes: "30" })));
    await expect(readPublicConfig("kumamoto")).rejects.toThrow(/公開設定の形/);
    expect(error).toHaveBeenCalledTimes(2);
    expect(String(error.mock.calls[1]?.[0])).toContain(path);
    expect(JSON.stringify(error.mock.calls[1]?.[1])).toContain("binMinutes");
    error.mockRestore();
  });
});
