import { isForceRequested, isTooSoon, MIN_SYNC_INTERVAL_MS, runCronJob } from "@/lib/cron";
import { hasSearchlightConfig } from "@/lib/env";
import { CROSS_PLATFORMS, getCrossInsightsFor, getInsights } from "@/lib/searchlight";
import { createSession } from "@/lib/searchlight-http";
import { getRun, recordRun } from "@/lib/state";
import { upsertCrossPosts, upsertSearchlightInsights } from "@/lib/store";
import { ensureMigrated } from "../_lib/migrate-once";

// migrate() が node:fs を使うため（他 cron と同じ理由で）明示する。
export const runtime = "nodejs";
// 79ページ前後を逐次取得するため 60 秒では足りない。ingest と同じ 300 にする。
export const maxDuration = 300;

/**
 * Searchlight の insight を Neon に取り込む。ダッシュボード本体（ingest）とは疎結合で、
 * 表示側は publishSnapshot 時に searchlight_insights / searchlight_cross_posts を結合する。
 * Vercel cron は GET で叩くため GET が本体。POST は手動実行用。
 *
 * 呼び出し回数の上限は2枚のガードで決まる（設計:
 * docs/superpowers/specs/2026-08-19-searchlight-sync-request-budget-design.md）。
 * 1) createSession の予算 = 1実行あたりの上限
 * 2) 間隔ゲート（下の extraGate） = 1日あたりの実行回数の上限
 * この2枚の積で、vercel.json の内容に依存せず上限が保たれる。
 *
 * 間隔ゲートを body ではなく extraGate に置くのは、skip が実行記録を書かないようにするため。
 * body で skip すると runCronJob が結果を記録して job_runs.finished_at が前進し、skip 自身が
 * 20時間の窓を張り直して本体が永久に動かなくなる（cron 周期が20時間未満のとき）。
 * 障害対応で即時に流したいときだけ `?force=1` でゲートを飛ばす（CRON_SECRET 認証は runCronJob 側）。
 */
export async function GET(req: Request): Promise<Response> {
  return runCronJob(
    "searchlight-sync",
    req,
    async (): Promise<Record<string, number>> => {
      // Searchlight は任意の拡張機能。未設定環境（別テーマへの転用時など）では
      // vercel.json の cron 設定を書き換えずに済むよう、ここで無害に skip する。
      // ゲート側に移さないのは、未設定環境では Searchlight を1回も叩かない＝間隔の窓が
      // ずれても無害であり、レスポンスの形（stats.skipped）を変える理由がないため。
      if (!hasSearchlightConfig()) return { skipped: 1 };

      const now = Date.now();

      // タイムアウト（maxDuration=300 超過）や OOM で殺されると runCronJob の recordRun は
      // 走らない。間隔ゲートは job_runs.finished_at を見るため、記録が無いままだとゲートが
      // 永久に開いたままになり、cron を短く戻された瞬間に事故が再現する。Searchlight を
      // 叩く前に「試行した」印を書いて間隔を先に消費させる。完走すれば runCronJob 側の
      // recordRun がこの行を実結果で上書きする（error が in-progress のまま残っていれば
      // 前回が完走しなかったという読み方ができる）。
      // ここで throw したら間隔を消費できていない＝叩かずに失敗させるのが正しい（fail-closed）。
      await recordRun({
        job: "searchlight-sync",
        startedAt: now,
        finishedAt: now,
        ok: false,
        stats: {},
        error: "in-progress",
      });

      const session = createSession();

      // 安全上限（MAX_PAGES）に当たった PF 数。1以上なら取りこぼしが起きているので、
      // job_runs だけで無言のデータ欠落に気づける（ingest の stats.truncated と同じ形）。
      let truncated = 0;

      const x = await getInsights(session, now);
      await upsertSearchlightInsights(x.rows);
      if (x.truncated) truncated++;

      // PF ごとに取得して即 upsert する。途中でタイムアウトしても失うのは最大1PF分で、
      // upsert は主キー冪等なので次回実行で収束する。
      let crossUpserted = 0;
      for (const platform of CROSS_PLATFORMS) {
        const cross = await getCrossInsightsFor(session, platform, now);
        await upsertCrossPosts(cross.rows);
        crossUpserted += cross.rows.length;
        if (cross.truncated) truncated++;
      }

      // requests を記録しておくと、job_runs だけで呼び出し回数の増加に気づける。
      return { upserted: x.rows.length, crossUpserted, requests: session.requestCount, truncated };
    },
    async () => {
      // 未設定環境は body 側で無害に skip させる（下の hasSearchlightConfig）。ここで DB を
      // 読んで "too-soon" を返すと、Searchlight を1回も叩かない環境のレスポンスの形が
      // 理由なく変わる。窓がずれても呼び出しは0なので、ゲートを通す方が副作用が小さい。
      if (!hasSearchlightConfig()) return null;

      // ゲートは job_runs を読み、body 冒頭の recordRun も job_runs に書く。未移行環境
      // （新規転用・別 Neon）では relation が無くて 500 になるため、ゲートより前に当てる。
      // ensureMigrated はメモ化済みで外部API呼び出しを伴わないので、ここに置いても無害。
      await ensureMigrated();
      if (isForceRequested(req.url)) return null;
      return isTooSoon(await getRun("searchlight-sync"), Date.now(), MIN_SYNC_INTERVAL_MS) ? "too-soon" : null;
    },
  );
}

export const POST = GET;
