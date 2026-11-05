import { describe, expect, it } from "vitest";
import type { JobRun } from "@/lib/types";
import { isBackfilling, pickSpreadSamples } from "./plan";

const ingestRun = (stats: Record<string, number>): JobRun => ({
  job: "ingest",
  startedAt: 0,
  finishedAt: 0,
  ok: true,
  stats,
  error: null,
});

describe("isBackfilling", () => {
  it("直近の ingest が分類を繰り越していれば遡り中とみなす", () => {
    expect(isBackfilling(ingestRun({ deferred: 3164 }))).toBe(true);
  });

  it("繰り越しが無い・記録が無い・stats に deferred が無いときは遡り中としない", () => {
    expect(isBackfilling(ingestRun({ deferred: 0 }))).toBe(false);
    expect(isBackfilling(null)).toBe(false);
    expect(isBackfilling(ingestRun({}))).toBe(false);
  });
});

describe("pickSpreadSamples", () => {
  const n = (createdAt: number) => ({ createdAt, summary: `s${createdAt}` });

  it("最古と最新を含め、期間全体から等間隔に選ぶ", () => {
    const notes = [9, 0, 5, 1, 8, 2, 7, 3, 6, 4].map(n);
    expect(pickSpreadSamples(notes, 5).map((x) => x.createdAt)).toEqual([0, 2, 5, 7, 9]);
  });

  it("件数以下ならすべてを古い順で返し、元の配列は並べ替えない", () => {
    const notes = [n(3), n(1)];
    expect(pickSpreadSamples(notes, 5).map((x) => x.createdAt)).toEqual([1, 3]);
    expect(notes.map((x) => x.createdAt)).toEqual([3, 1]);
  });

  it("1件だけ選ぶときは最新を返す", () => {
    expect(pickSpreadSamples([n(1), n(3), n(2)], 1).map((x) => x.createdAt)).toEqual([3]);
  });
});
