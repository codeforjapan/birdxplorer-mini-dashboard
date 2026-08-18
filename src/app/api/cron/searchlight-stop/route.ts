import { runShutdownJob } from "@/lib/cron";
import { disableCollection } from "@/lib/searchlight";

// Searchlight のトークン取得に fetch を使うのみだが、他 cron と揃えて Node ランタイムで動かす。
export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * 監視終了（MONITOR_END_DATE 経過）後に Searchlight の自動収集を止める停止ジョブ。
 *
 * ダッシュボードの他 cron は runCronJob で「終了後は no-op」になるが、Searchlight は別システムで、
 * enabled=false にするまで日次収集＝課金が無期限に続く。この停止だけは「終了してから」動く必要があるため
 * runShutdownJob（ゲート反転）を使う。冪等なので毎時叩いても無害（false を再アサートし続ける）。
 * Vercel cron は GET で叩く。POST は手動実行用。
 */
export async function GET(req: Request): Promise<Response> {
  return runShutdownJob("searchlight-stop", req, async () => {
    return disableCollection();
  });
}

export const POST = GET;
