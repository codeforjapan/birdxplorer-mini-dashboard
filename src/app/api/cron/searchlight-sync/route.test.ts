import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TenantJobBody } from "@/lib/cron";
import { resolveTenantConfig } from "@/lib/tenant/resolve";
import type { TenantRecord, TenantSettings } from "@/lib/tenant/types";

const mocks = vi.hoisted(() => ({
  hasConfig: true,
  recordRun: vi.fn(),
  getInsights: vi.fn(),
  body: null as TenantJobBody | null,
}));

// ゲートと記録は cron.ts の責務なので、ここでは body だけを直接呼ぶ
vi.mock("@/lib/cron", () => ({
  isForceRequested: () => false,
  isTooSoon: () => false,
  MIN_SYNC_INTERVAL_MS: 0,
  runTenantCronJob: async (_job: string, _req: Request, body: TenantJobBody) => {
    mocks.body = body;
    return new Response(null);
  },
}));
vi.mock("@/lib/env", () => ({ hasSearchlightConfig: () => mocks.hasConfig }));
vi.mock("@/lib/searchlight", () => ({
  CROSS_PLATFORMS: [],
  getCrossInsightsFor: vi.fn(),
  getInsights: mocks.getInsights,
}));
vi.mock("@/lib/searchlight-http", () => ({ createSession: () => ({ requestCount: 0 }) }));
vi.mock("@/lib/state", () => ({ getRun: vi.fn(), recordRun: mocks.recordRun }));
vi.mock("@/lib/store", () => ({ upsertCrossPosts: vi.fn(), upsertSearchlightInsights: vi.fn() }));
vi.mock("../_lib/migrate-once", () => ({ ensureMigrated: vi.fn() }));

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
  status: "active",
  settings,
  overrides: {},
  searchlightStoppedAt: null,
  updatedAt: 1,
};

async function run(r: TenantRecord = rec): Promise<Record<string, number>> {
  await GET(new Request("https://example.com"));
  if (mocks.body === null) throw new Error("body が渡されていない");
  return mocks.body(resolveTenantConfig(r), r);
}

describe("searchlight-sync", () => {
  beforeEach(() => {
    mocks.hasConfig = true;
    mocks.recordRun.mockReset();
    mocks.getInsights.mockReset();
  });

  it("topic の無い事例は Searchlight を叩かずに skip", async () => {
    expect(await run({ ...rec, settings: { ...settings, searchlightTopicId: null } })).toEqual({ skipped: 1 });
    expect(mocks.getInsights).not.toHaveBeenCalled();
  });

  it("topic があるのに Searchlight の環境変数が無ければ skip ではなく失敗", async () => {
    mocks.hasConfig = false;
    await expect(run()).rejects.toThrow(/環境変数が未設定/);
    expect(mocks.recordRun).not.toHaveBeenCalled();
    expect(mocks.getInsights).not.toHaveBeenCalled();
  });
});
