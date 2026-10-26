import { runTenantShutdownJob } from "@/lib/cron";
import { hasSearchlightConfig } from "@/lib/env";
import { disableCollection } from "@/lib/searchlight";
import { createSession } from "@/lib/searchlight-http";
import { publishTenant } from "@/lib/tenant/publish";
import { markSearchlightStopped } from "@/lib/tenant/repo";

// Searchlight のトークン取得に fetch を使うのみだが、他 cron と揃えて Node ランタイムで動かす。
export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * 事例の終了後に Searchlight の自動収集を止める停止ジョブ。
 *
 * ダッシュボードの他 cron は runTenantCronJob で「終了後は no-op」になるが、Searchlight は別システムで、
 * enabled=false にするまで日次収集＝課金が無期限に続く。この停止だけは「終了してから」動く必要があるため
 * runTenantShutdownJob（ゲート反転）を使う。冪等なので何度叩いても無害（false を再アサートし続ける）。
 * Vercel cron は GET で叩く。POST は手動実行用。
 */
export async function GET(req: Request): Promise<Response> {
  return runTenantShutdownJob("searchlight-stop", req, async (cfg, rec): Promise<Record<string, number>> => {
    if (cfg.searchlightTopicId === null || !hasSearchlightConfig()) return { skipped: 1 };

    const session = createSession();
    const { topicsDisabled } = await disableCollection(session);

    // 停止を記録して index.json を作り直し、以後 dispatch の対象から外す（設計書 §5.4）。
    // 記録に失敗した場合は失敗として残し、翌日また止め直す（停止は冪等）。
    const stoppedAt = Date.now();
    await markSearchlightStopped(cfg.slug, stoppedAt);
    await publishTenant({ ...rec, searchlightStoppedAt: stoppedAt });

    return { topicsDisabled, requests: session.requestCount };
  });
}

export const POST = GET;
