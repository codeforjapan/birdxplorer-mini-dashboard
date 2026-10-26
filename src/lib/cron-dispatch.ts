import { isTenantMonitoring, isTenantMonitoringEnded } from "./tenant/resolve";
import type { TenantIndexEntry } from "./tenant/publish";
import type { JobName } from "./types";

/**
 * ingest の時間差実行。
 *
 * ingest は BirdXplorer API の重い検索（/data/search の post_includes_text = LIKE）を
 * 1回に2本投げる。監視期間が重なる事例が同時に投げると、API（1台・0.5 vCPU）で
 * タイムアウトしやすい。振り分け役の中で sleep して間をあけると maxDuration を超えるので、
 * cron を2分ごとに回し、どの事例を動かすかを回ごとに振り分ける（各事例は 2分×5枠=10分ごと）。
 */
export const INGEST_SLOTS = 5;
export const INGEST_TICK_MINUTES = 2;

/** 分で割るので、cron が1分遅れて発火しても同じ枠に入る。 */
export function ingestSlotOf(now: number): number {
  return Math.floor(new Date(now).getUTCMinutes() / INGEST_TICK_MINUTES) % INGEST_SLOTS;
}

export function selectTenantsForJob(job: JobName, index: TenantIndexEntry[], now: number = Date.now()): string[] {
  // 枠の割り当てを index の並び順に依存させない
  const sorted = [...index].sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  const monitoring = sorted.filter((e) => isTenantMonitoring(e, now));

  switch (job) {
    case "ingest": {
      const slot = ingestSlotOf(now);
      return monitoring.filter((_, i) => i % INGEST_SLOTS === slot).map((e) => e.slug);
    }
    case "searchlight-sync":
      return monitoring.filter((e) => e.hasSearchlight).map((e) => e.slug);
    case "searchlight-stop":
      return sorted
        .filter(
          (e) =>
            (e.status === "ended" || isTenantMonitoringEnded(e, now)) && e.hasSearchlight && !e.searchlightStopped,
        )
        .map((e) => e.slug);
    default:
      return monitoring.map((e) => e.slug);
  }
}

export type DispatchResult = { slug: string; status: number | "error" };

/**
 * 各事例の作業ルートを別の関数実行として並列に呼ぶ。1件が失敗・タイムアウトしても
 * 他の事例は止めず、全件の結果を返す（例外は投げない）。
 */
export async function dispatchJob(
  job: JobName,
  origin: string,
  slugs: string[],
  secret: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DispatchResult[]> {
  return Promise.all(
    slugs.map(async (slug): Promise<DispatchResult> => {
      const url = `${origin}/api/cron/${job}?tenant=${encodeURIComponent(slug)}`;
      try {
        const res = await fetchImpl(url, {
          method: "GET",
          headers: { authorization: `Bearer ${secret}` },
          cache: "no-store",
        });
        return { slug, status: res.status };
      } catch (e) {
        console.error(`[dispatch:${job}] ${slug} の呼び出しに失敗`, e);
        return { slug, status: "error" };
      }
    }),
  );
}
