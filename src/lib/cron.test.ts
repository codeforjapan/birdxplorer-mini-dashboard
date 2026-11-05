import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TenantRecord, TenantSettings } from "./tenant/types";

const repo = vi.hoisted(() => ({ getTenant: vi.fn<(slug: string) => Promise<TenantRecord | null>>() }));
vi.mock("./tenant/repo", () => repo);

const state = vi.hoisted(() => ({ recordRun: vi.fn(async () => {}) }));
vi.mock("./state", () => state);

import { runTenantCronJob, runTenantShutdownJob, type TenantJobBody } from "./cron";

const SETTINGS: TenantSettings = {
  slug: "a",
  siteTitle: "t",
  siteDescription: "d",
  eyebrowLabel: "",
  scheduleLabel: "",
  monitorStartAt: 0,
  monitorEndDate: "2999-12-31",
  searchKeywords: ["x"],
  llmContextPhrase: "",
  llmContextPhraseCompact: "",
  llmContextPhraseShort: "",
  keyMoments: [],
  keyMomentLabel: "",
  keyMomentValue: "",
  githubRepo: "",
  appTitle: "",
  issuesUrl: "",
  officialSourcesIntro: "",
  officialSources: [],
  officialSourcesDisclaimer: "",
  searchlightTopicId: null,
};

function rec(over: Partial<TenantRecord> = {}): TenantRecord {
  return {
    slug: "a",
    type: "disaster",
    status: "active",
    settings: SETTINGS,
    overrides: {},
    searchlightStoppedAt: null,
    updatedAt: 0,
    ...over,
  };
}

function req(query: string, auth = "Bearer sec"): Request {
  return new Request(`https://example.org/api/cron/ingest${query}`, { headers: { authorization: auth } });
}

beforeEach(() => {
  vi.stubEnv("CRON_SECRET", "sec");
  repo.getTenant.mockReset();
  state.recordRun.mockClear();
});

describe("runTenantCronJob", () => {
  it("認証が無ければ DB に触らず 401", async () => {
    const res = await runTenantCronJob("ingest", req("?tenant=a", "Bearer nope"), async () => ({}));
    expect(res.status).toBe(401);
    expect(repo.getTenant).not.toHaveBeenCalled();
  });

  it("?tenant= が無ければ 400", async () => {
    const res = await runTenantCronJob("ingest", req(""), async () => ({}));
    expect(res.status).toBe(400);
    expect(repo.getTenant).not.toHaveBeenCalled();
  });

  it("未登録の事例は 404（getTenant は1回だけ）", async () => {
    repo.getTenant.mockResolvedValue(null);
    const res = await runTenantCronJob("ingest", req("?tenant=zz"), async () => ({}));
    expect(res.status).toBe(404);
    expect(repo.getTenant).toHaveBeenCalledTimes(1);
    expect(repo.getTenant).toHaveBeenCalledWith("zz");
  });

  it("監視中なら body に解決済み設定を渡し、事例単位で記録する", async () => {
    repo.getTenant.mockResolvedValue(rec());
    const body = vi.fn<TenantJobBody>(async () => ({ n: 1 }));
    const res = await runTenantCronJob("ingest", req("?tenant=a"), body);
    expect(res.status).toBe(200);
    expect(body.mock.calls[0]?.[0]).toMatchObject({ slug: "a", classifierVersion: expect.any(String) });
    expect(state.recordRun).toHaveBeenCalledWith("a", expect.objectContaining({ job: "ingest", ok: true }));
    expect(repo.getTenant).toHaveBeenCalledTimes(1);
  });

  it("監視中でなければ記録を書かずに skip", async () => {
    repo.getTenant.mockResolvedValue(rec({ status: "ended" }));
    const body = vi.fn(async () => ({}));
    const res = await runTenantCronJob("ingest", req("?tenant=a"), body);
    expect(await res.json()).toMatchObject({ skipped: "not-monitoring" });
    expect(body).not.toHaveBeenCalled();
    expect(state.recordRun).not.toHaveBeenCalled();
  });

  it("追加ゲートの skip も記録しない", async () => {
    repo.getTenant.mockResolvedValue(rec());
    const body = vi.fn(async () => ({}));
    const res = await runTenantCronJob("searchlight-sync", req("?tenant=a"), body, () => "too-soon");
    expect(await res.json()).toMatchObject({ skipped: "too-soon" });
    expect(body).not.toHaveBeenCalled();
    expect(state.recordRun).not.toHaveBeenCalled();
  });

  it("body の例外は記録して 500", async () => {
    repo.getTenant.mockResolvedValue(rec());
    const res = await runTenantCronJob("ingest", req("?tenant=a"), async () => {
      throw new Error("boom");
    });
    expect(res.status).toBe(500);
    expect(state.recordRun).toHaveBeenCalledWith("a", expect.objectContaining({ ok: false }));
  });
});

describe("runTenantShutdownJob", () => {
  it("監視中は skip", async () => {
    repo.getTenant.mockResolvedValue(rec());
    const body = vi.fn(async () => ({}));
    const res = await runTenantShutdownJob("searchlight-stop", req("?tenant=a"), body);
    expect(await res.json()).toMatchObject({ skipped: "monitoring-active" });
    expect(body).not.toHaveBeenCalled();
  });

  it("status が ended、または終了日経過なら動く", async () => {
    const body = vi.fn(async () => ({}));
    repo.getTenant.mockResolvedValue(rec({ status: "ended" }));
    expect((await runTenantShutdownJob("searchlight-stop", req("?tenant=a"), body)).status).toBe(200);
    repo.getTenant.mockResolvedValue(rec({ settings: { ...SETTINGS, monitorEndDate: "2000-01-01" } }));
    expect((await runTenantShutdownJob("searchlight-stop", req("?tenant=a"), body)).status).toBe(200);
    expect(body).toHaveBeenCalledTimes(2);
  });
});
