import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TenantJobBody } from "@/lib/cron";
import { resolveTenantConfig } from "@/lib/tenant/resolve";
import type { TenantRecord, TenantSettings } from "@/lib/tenant/types";

const mocks = vi.hoisted(() => ({
  topics: [] as unknown,
  puts: [] as string[],
  markSearchlightStopped: vi.fn(),
  publishTenant: vi.fn(),
  body: null as TenantJobBody | null,
}));

// ゲートと記録は cron.ts の責務なので、ここでは body だけを直接呼ぶ
vi.mock("@/lib/cron", () => ({
  runTenantShutdownJob: async (_job: string, _req: Request, body: TenantJobBody) => {
    mocks.body = body;
    return new Response(null);
  },
}));
vi.mock("@/lib/env", () => ({
  hasSearchlightConfig: () => true,
  searchlightEnv: () => ({ SEARCHLIGHT_COMPANY_ID: "co1" }),
}));
vi.mock("@/lib/searchlight-http", () => ({
  createSession: () => ({
    getJson: async () => mocks.topics,
    putJson: async (path: string) => {
      mocks.puts.push(path);
    },
    requestCount: 1,
  }),
}));
vi.mock("@/lib/tenant/repo", () => ({ markSearchlightStopped: mocks.markSearchlightStopped }));
vi.mock("@/lib/tenant/publish", () => ({ publishTenant: mocks.publishTenant }));

import { GET } from "./route";

const settings: TenantSettings = {
  slug: "t",
  siteTitle: "テスト",
  siteDescription: "説明",
  eyebrowLabel: "e",
  scheduleLabel: "s",
  monitorStartAt: Date.parse("2026-08-01T00:00:00+09:00"),
  monitorEndDate: "2026-09-20",
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
  searchlightTopicId: "t2",
};

const rec: TenantRecord = {
  slug: "t",
  type: "disaster",
  status: "ended",
  settings,
  overrides: {},
  searchlightStoppedAt: null,
  updatedAt: 1,
};

async function run(): Promise<Record<string, number>> {
  await GET(new Request("https://example.com"));
  if (mocks.body === null) throw new Error("body が渡されていない");
  return mocks.body(resolveTenantConfig(rec), rec);
}

const topic = (id: string, enabled: boolean) => ({
  id,
  collectionConfig: { enabled, platforms: [{ platform: "x", enabled }] },
});

describe("searchlight-stop", () => {
  beforeEach(() => {
    mocks.puts.length = 0;
    mocks.markSearchlightStopped.mockReset();
    mocks.publishTenant.mockReset();
  });

  it("有効なトピックを止めて停止済みと記録する", async () => {
    mocks.topics = [topic("t1", true), topic("t2", true)];
    expect(await run()).toMatchObject({ topicsDisabled: 1 });
    expect(mocks.puts).toEqual(["/companies/co1/topics/t2"]);
    expect(mocks.markSearchlightStopped).toHaveBeenCalledOnce();
    expect(mocks.publishTenant).toHaveBeenCalledOnce();
  });

  it("既に止まっているトピックも停止済みと記録する（冪等）", async () => {
    mocks.topics = [topic("t2", false)];
    expect(await run()).toMatchObject({ topicsDisabled: 0 });
    expect(mocks.puts).toEqual([]);
    expect(mocks.markSearchlightStopped).toHaveBeenCalledOnce();
  });

  it("トピックが一覧に無ければ停止済みと記録しない", async () => {
    mocks.topics = [topic("t1", true)];
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await run()).toMatchObject({ topicNotFound: 1 });
    expect(error).toHaveBeenCalledOnce();
    expect(mocks.puts).toEqual([]);
    expect(mocks.markSearchlightStopped).not.toHaveBeenCalled();
    expect(mocks.publishTenant).not.toHaveBeenCalled();
    error.mockRestore();
  });
});
