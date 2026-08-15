import { runCronJob } from "@/lib/cron";
import { hasSearchlightConfig } from "@/lib/env";
import { getCrossInsights, getInsights } from "@/lib/searchlight";
import { upsertCrossPosts, upsertSearchlightInsights } from "@/lib/store";
import { ensureMigrated } from "../_lib/migrate-once";

// migrate() が node:fs を使うため（他 cron と同じ理由で）明示する。
export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Searchlight の X insight を Neon に取り込む。ダッシュボード本体（ingest）とは疎結合で、
 * 表示側は publishSnapshot 時に searchlight_insights を結合する。
 * Vercel cron は GET で叩くため GET が本体。POST は手動実行用。
 */
export async function GET(req: Request): Promise<Response> {
  return runCronJob("searchlight-sync", req, async (): Promise<Record<string, number>> => {
    // Searchlight は任意の拡張機能。未設定環境（別テーマへの転用時など）では
    // vercel.json の cron 設定を書き換えずに済むよう、ここで無害に skip する。
    if (!hasSearchlightConfig()) return { skipped: 1 };

    await ensureMigrated();
    const rows = await getInsights();
    await upsertSearchlightInsights(rows);
    const crossRows = await getCrossInsights();
    await upsertCrossPosts(crossRows);
    return { upserted: rows.length, crossUpserted: crossRows.length };
  });
}

export const POST = GET;
