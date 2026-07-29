import { timingSafeEqual } from "node:crypto";
import { cronSecret, isMonitoringEnded } from "./env";
import { recordRun } from "./state";
import type { JobName, JobRun } from "./types";

/**
 * cron ハンドラの共通枠。
 *
 * 認証・運用期間の判定・実行記録・エラー捕捉をここに集約する。
 * 各ジョブは「何をするか」だけを書けばよい。
 *
 * ジョブは例外を投げてよい。捕捉して KV に記録し 500 を返す
 * （外部通知はなく、Vercel のランタイムログと KV が唯一の追跡手段）。
 */

function isAuthorized(req: Request): boolean {
  const header = req.headers.get("authorization") ?? "";
  const expected = `Bearer ${cronSecret()}`;

  // 長さが違うと timingSafeEqual が例外を投げるため先に弾く。
  // 長さの漏洩は許容する（シークレットの長さは固定で秘密ではない）。
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** ジョブ本体。返した値は実行記録の stats に入る。 */
export type JobBody = () => Promise<Record<string, number>>;

export async function runCronJob(job: JobName, req: Request, body: JobBody): Promise<Response> {
  if (!isAuthorized(req)) {
    // 認証失敗は KV に記録しない（外部からの試行でジョブ履歴が埋まるのを防ぐ）。
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  // 8/31 を過ぎたら何もしない。デプロイは残し、サイトは静的アーカイブとして機能させる。
  if (isMonitoringEnded()) {
    return Response.json({ job, skipped: "monitoring-ended" });
  }

  const startedAt = Date.now();
  let run: JobRun;

  try {
    const stats = await body();
    run = { job, startedAt, finishedAt: Date.now(), ok: true, stats, error: null };
  } catch (e) {
    run = {
      job,
      startedAt,
      finishedAt: Date.now(),
      ok: false,
      stats: {},
      error: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
    };
  }

  // 記録の失敗でジョブの成否を覆さない。KV が落ちていても本体が成功したなら成功を返す。
  try {
    await recordRun(run);
  } catch (e) {
    console.error(`[cron:${job}] 実行記録の書き込みに失敗`, e);
  }

  if (!run.ok) console.error(`[cron:${job}] 失敗`, run.error);

  return Response.json(
    { job, ok: run.ok, durationMs: run.finishedAt - run.startedAt, stats: run.stats, error: run.error },
    { status: run.ok ? 200 : 500 },
  );
}
