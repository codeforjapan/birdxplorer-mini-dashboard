import { describe, expect, it, vi } from "vitest";
import { dispatchJob, ingestSlotOf, INGEST_SLOTS, selectTenantsForJob } from "./cron-dispatch";
import type { TenantIndexEntry } from "./tenant/publish";

const at = (hhmm: string) => Date.parse(`2026-11-01T${hhmm}:00Z`);
const START = Date.parse("2026-10-01T00:00:00+09:00");

function entry(slug: string, over: Partial<TenantIndexEntry> = {}): TenantIndexEntry {
  return {
    slug,
    status: "active",
    monitorStartAt: START,
    monitorEndDate: "2026-12-31",
    hasSearchlight: false,
    searchlightStopped: false,
    ...over,
  };
}

describe("ingestSlotOf", () => {
  it("UTC の分を2分刻みにし、5枠で回す", () => {
    expect(INGEST_SLOTS).toBe(5);
    expect(ingestSlotOf(at("00:00"))).toBe(0);
    expect(ingestSlotOf(at("00:03"))).toBe(1);
    expect(ingestSlotOf(at("00:08"))).toBe(4);
    expect(ingestSlotOf(at("00:10"))).toBe(0);
    expect(ingestSlotOf(at("13:58"))).toBe(4);
  });
});

describe("selectTenantsForJob", () => {
  // slug 順に並べ替えることも確かめるため、わざと順不同で渡す
  const index = [entry("c"), entry("a"), entry("b")];

  it("ingest は監視中の事例のうち、その回の枠に当たるものだけ", () => {
    expect(selectTenantsForJob("ingest", index, at("00:00"))).toEqual(["a"]);
    expect(selectTenantsForJob("ingest", index, at("00:02"))).toEqual(["b"]);
    expect(selectTenantsForJob("ingest", index, at("00:04"))).toEqual(["c"]);
    expect(selectTenantsForJob("ingest", index, at("00:06"))).toEqual([]);
    expect(selectTenantsForJob("ingest", index, at("00:08"))).toEqual([]);
    expect(selectTenantsForJob("ingest", index, at("00:10"))).toEqual(["a"]);
  });

  it("cron が1分遅れても同じ枠に入る", () => {
    expect(selectTenantsForJob("ingest", index, at("00:03"))).toEqual(["b"]);
  });

  it("監視中が6件以上なら i % 5 で枠を共有する", () => {
    const six = ["a", "b", "c", "d", "e", "f"].map((s) => entry(s));
    expect(selectTenantsForJob("ingest", six, at("00:00"))).toEqual(["a", "f"]);
    expect(selectTenantsForJob("ingest", six, at("00:02"))).toEqual(["b"]);
  });

  it("ingest は監視中でない事例を枠の数え方に含めない", () => {
    const mixed = [entry("a", { status: "draft" }), entry("b"), entry("c", { monitorEndDate: "2026-10-31" })];
    expect(selectTenantsForJob("ingest", mixed, at("00:00"))).toEqual(["b"]);
  });

  it("ingest 以外には枠を適用せず、監視中を全件返す", () => {
    const mixed = [...index, entry("d", { status: "ended" }), entry("e", { monitorStartAt: at("00:01") })];
    for (const job of ["recluster", "refresh-status", "report"] as const) {
      expect(selectTenantsForJob(job, mixed, at("00:00"))).toEqual(["a", "b", "c"]);
    }
  });

  it("終了日の当日いっぱいは監視中、翌日 00:00 JST から外れる", () => {
    const one = [entry("a", { monitorEndDate: "2026-11-01" })];
    expect(selectTenantsForJob("recluster", one, Date.parse("2026-11-01T23:59:59+09:00"))).toEqual(["a"]);
    expect(selectTenantsForJob("recluster", one, Date.parse("2026-11-02T00:00:00+09:00"))).toEqual([]);
  });

  it("searchlight-sync は監視中かつ Searchlight ありだけ", () => {
    const list = [
      entry("a", { hasSearchlight: true }),
      entry("b"),
      entry("c", { hasSearchlight: true, status: "ended" }),
    ];
    expect(selectTenantsForJob("searchlight-sync", list, at("00:00"))).toEqual(["a"]);
  });

  it("searchlight-stop は終了済み・Searchlight あり・未停止だけ", () => {
    const list = [
      entry("a", { hasSearchlight: true, status: "ended" }),
      entry("b", { hasSearchlight: true, monitorEndDate: "2026-10-31" }),
      entry("c", { hasSearchlight: true, status: "ended", searchlightStopped: true }),
      entry("d", { status: "ended" }),
      entry("e", { hasSearchlight: true }),
    ];
    expect(selectTenantsForJob("searchlight-stop", list, at("00:00"))).toEqual(["a", "b"]);
  });
});

describe("dispatchJob", () => {
  it("1件の失敗で他を止めず、全件の結果を並列に集める", async () => {
    const calls: { url: string; auth: string | null }[] = [];
    let releaseAll!: () => void;
    const allCalled = new Promise<void>((r) => (releaseAll = r));

    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, auth: new Headers(init?.headers).get("authorization") });
      if (calls.length === 3) releaseAll();
      // 全件が呼ばれるまで応答しない＝直列実装だとここで止まってテストが落ちる
      await allCalled;
      if (url.endsWith("tenant=a")) return new Response("{}", { status: 200 });
      if (url.endsWith("tenant=b")) return new Response("{}", { status: 500 });
      throw new Error("timeout");
    });

    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const results = await dispatchJob("ingest", "https://example.org", ["a", "b", "c"], "s3cret", fetchImpl);
    expect(error).toHaveBeenCalledTimes(2);
    error.mockRestore();

    expect(results).toEqual([
      { slug: "a", status: 200 },
      { slug: "b", status: 500 },
      { slug: "c", status: "error" },
    ]);
    expect(calls.map((c) => c.url)).toEqual([
      "https://example.org/api/cron/ingest?tenant=a",
      "https://example.org/api/cron/ingest?tenant=b",
      "https://example.org/api/cron/ingest?tenant=c",
    ]);
    expect(calls.every((c) => c.auth === "Bearer s3cret")).toBe(true);
  });

  it("失敗は他の事例の完了を待たずに、その場でログに出す", async () => {
    let releaseA!: () => void;
    const aDone = new Promise<void>((r) => (releaseA = r));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith("tenant=a")) {
        await aDone;
        return new Response("{}", { status: 200 });
      }
      return new Response("{}", { status: 500 });
    });

    const pending = dispatchJob("report", "https://example.org", ["a", "b"], "s", fetchImpl);
    await vi.waitFor(() => expect(error).toHaveBeenCalledOnce());
    expect(String(error.mock.calls[0]?.[0])).toContain("b が HTTP 500");
    releaseA();
    await pending;
    expect(error).toHaveBeenCalledOnce();
    error.mockRestore();
  });

  it("対象が無ければ呼ばない", async () => {
    const fetchImpl = vi.fn();
    expect(await dispatchJob("report", "https://example.org", [], "s", fetchImpl)).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
