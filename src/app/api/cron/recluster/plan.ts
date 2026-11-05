import type { JobRun } from "@/lib/types";

/**
 * 直近の ingest が分類を次回へ繰り越していれば、遡り分類の途中とみなす。
 * 遡り中は1時間に数百件ずつ新しいクラスタが増え、それを毎時統合すると統合先へさらに
 * 統合が連鎖して雪だるま式に膨らむ（2026-10-30 熊本再現試験で 124 本が1本に吸収された）。
 */
export function isBackfilling(lastIngest: JobRun | null): boolean {
  return (lastIngest?.stats.deferred ?? 0) > 0;
}

/**
 * 期間全体から最古と最新を含めて等間隔に limit 件選び、古い順で返す。
 * 直近だけを渡すと、大きなクラスタが最近の少数派の話題で改名される。
 */
export function pickSpreadSamples<T extends { createdAt: number }>(notes: readonly T[], limit: number): T[] {
  const sorted = [...notes].sort((a, b) => a.createdAt - b.createdAt);
  if (sorted.length <= limit) return sorted;
  if (limit === 1) return [sorted[sorted.length - 1]];
  return Array.from({ length: limit }, (_, i) => sorted[Math.round((i * (sorted.length - 1)) / (limit - 1))]);
}
