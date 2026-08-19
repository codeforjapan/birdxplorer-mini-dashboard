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

/**
 * 同期の最小実行間隔。cron の設定が短く戻されても、外部APIを叩く回数がコード側で頭打ちになる。
 * 24時間ではなく20時間にするのは、日次 cron の実行時刻が前後してもゲートに弾かれて
 * 1日飛ぶことがないようにするため。
 */
export const MIN_SYNC_INTERVAL_MS = 20 * 60 * 60 * 1000;

/**
 * 最後の試行から minIntervalMs 経っていないか。
 *
 * `ok` は見ない＝成功・失敗を問わず「最後の試行」から数える。「成功時のみ間隔を消費する」
 * 設計だと、恒久的に失敗する状態（例: 認証切れ）と cron 頻度の巻き戻しが重なったとき、
 * すべての実行がゲートを通過して外部APIを叩き続ける。それは 2026-08 の事故の再現である。
 */
export function isTooSoon(lastRun: JobRun | null, now: number, minIntervalMs: number): boolean {
  return lastRun !== null && now - lastRun.finishedAt < minIntervalMs;
}

/**
 * `?force=1` が付いているか。間隔ゲートを飛ばす障害対応用の逃げ道。
 *
 * `=1` の厳密一致にするのは、Vercel cron が叩く経路（クエリ無し）が絶対にゲートを
 * 飛ばさないことをコード上で明白にするため。`?force=true` や値なしの `?force` では
 * 効かない（意図的に狭くしてある。逃げ道は広げるほど日常的に踏まれる）。
 */
export function isForceRequested(url: string): boolean {
  return new URL(url).searchParams.get("force") === "1";
}

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

/**
 * ゲート。skip する理由（文字列）を返すと body は呼ばれない。実行するなら null。
 *
 * 非同期を許すのは、間隔ゲートのように判定自体が DB を読む場合があるため
 * （searchlight-sync）。既存の同期ゲート（isMonitoringEnded）はそのまま渡せる。
 */
export type SkipGate = () => string | null | Promise<string | null>;

/**
 * 認証・スキップ判定・実行記録・エラー処理を共通化した内部枠。
 * ゲート（いつ body を呼ばず即返すか）だけを `skipReason` で外から差し込む。
 * `skipReason` が文字列を返したら body を実行せず `{skipped}` を返す（null なら実行）。
 */
async function runGatedJob(
  job: JobName,
  req: Request,
  body: JobBody,
  skipReason: SkipGate,
): Promise<Response> {
  if (!isAuthorized(req)) {
    // 認証失敗は KV に記録しない（外部からの試行でジョブ履歴が埋まるのを防ぐ）。
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const startedAt = Date.now();
  let run: JobRun;

  try {
    const skipped = await skipReason();
    // skip は**実行記録を書かずに**返す。書いてしまうと job_runs.finished_at が skip 自身で
    // 前進し、間隔ゲート（isTooSoon）が毎回自分で窓を張り直して本体が永久に動かなくなる。
    // 記録を実際の試行だけに限ることで「最後にいつ本当に同期したか」も追える。
    if (skipped) return Response.json({ job, skipped });

    const stats = await body();
    run = { job, startedAt, finishedAt: Date.now(), ok: true, stats, error: null };
  } catch (e) {
    // skipReason の失敗（間隔ゲートの DB 読み取り等）もここに来る。body は呼ばれていない＝
    // 外部APIは1回も叩いていないが、黙って 200 を返すと「実行されなかったこと」に
    // 気づけないため、通常の失敗と同じ経路で記録して 500 にする。
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

/**
 * 通常 cron の共通枠。監視終了（MONITOR_END_DATE 経過）後は body を呼ばず no-op。
 * デプロイは残し、サイトは静的アーカイブとして機能させる。
 *
 * `extraGate` はジョブ固有の追加ゲート（省略可）。監視終了の判定を通ったときだけ評価する
 * ＝終了後は追加ゲートの副作用（DB 読み取り等）も走らない。ここに渡したゲートは
 * 記録を書かずに skip するため、「skip 自身が間隔の窓をずらす」ことがない。
 */
export async function runCronJob(
  job: JobName,
  req: Request,
  body: JobBody,
  extraGate?: SkipGate,
): Promise<Response> {
  return runGatedJob(job, req, body, async () => {
    if (isMonitoringEnded()) return "monitoring-ended";
    return extraGate ? await extraGate() : null;
  });
}

/**
 * 停止（shutdown）ジョブの共通枠。runCronJob とゲートが真逆で、**監視期間が終わってから**
 * 本体を動かす（例: MONITOR_END_DATE 経過後に外部収集を止める）。運用中（未終了）は no-op。
 * body は冪等であること（毎回叩かれても無害）を前提にする。
 */
export async function runShutdownJob(job: JobName, req: Request, body: JobBody): Promise<Response> {
  return runGatedJob(job, req, body, () => (isMonitoringEnded() ? null : "monitoring-active"));
}
