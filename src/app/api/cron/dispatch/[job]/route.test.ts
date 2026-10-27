import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DispatchResult } from "@/lib/cron-dispatch";

const mocks = vi.hoisted(() => ({
  readTenantIndex: vi.fn(),
  dispatchJob: vi.fn<() => Promise<DispatchResult[]>>(),
}));

vi.mock("@/lib/cron", () => ({ isAuthorized: () => true }));
vi.mock("@/lib/cron-dispatch", () => ({
  dispatchJob: mocks.dispatchJob,
  selectTenantsForJob: () => ["a", "b"],
}));
vi.mock("@/lib/env", () => ({ cronSecret: () => "s", cronSelfOrigin: () => "https://example.org" }));
vi.mock("@/lib/tenant/publish", () => ({ readTenantIndex: mocks.readTenantIndex }));

import { GET } from "./route";

async function call(): Promise<Response> {
  return GET(new Request("https://example.org/api/cron/dispatch/report"), {
    params: Promise.resolve({ job: "report" }),
  });
}

describe("dispatch", () => {
  beforeEach(() => {
    mocks.readTenantIndex.mockReset().mockResolvedValue([]);
    mocks.dispatchJob.mockReset();
  });

  it("全事例が 200 なら 200", async () => {
    mocks.dispatchJob.mockResolvedValue([
      { slug: "a", status: 200 },
      { slug: "b", status: 200 },
    ]);
    const res = await call();
    expect(res.status).toBe(200);
  });

  it("1件でも失敗すれば 502 で、本文に全件の結果を含める", async () => {
    const results: DispatchResult[] = [
      { slug: "a", status: 200 },
      { slug: "b", status: "error" },
    ];
    mocks.dispatchJob.mockResolvedValue(results);
    const res = await call();
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ job: "report", results });
  });

  it("事例一覧が読めなければ 500", async () => {
    mocks.readTenantIndex.mockRejectedValue(new Error("tenants/index.json がありません"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await call();
    expect(res.status).toBe(500);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});
