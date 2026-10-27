import { timingSafeEqual } from "node:crypto";
import { cronSecret } from "./env";
import { recordRun } from "./state";
import { getTenant } from "./tenant/repo";
import { isTenantMonitoring, isTenantMonitoringEnded, resolveTenantConfig } from "./tenant/resolve";
import type { TenantConfig, TenantRecord } from "./tenant/types";
import type { JobName, JobRun } from "./types";

/**
 * cron ハンドラの共通枠。
 *
 * 認証・事例の解決・運用期間の判定・実行記録・エラー捕捉をここに集約する。
 * 各ジョブは「何をするか」だけを書けばよい。作業ルートは `?tenant=<slug>` で1事例だけを処理する。
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

export function isAuthorized(req: Request): boolean {
  const header = req.headers.get("authorization") ?? "";
  const expected = `Bearer ${cronSecret()}`;

  // 長さが違うと timingSafeEqual が例外を投げるため先に弾く。
  // 長さの漏洩は許容する（シークレットの長さは固定で秘密ではない）。
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** ジョブ本体。返した値は実行記録の stats に入る。rec は終了処理で公開設定を書き直すときに使う。 */
export type TenantJobBody = (cfg: TenantConfig, rec: TenantRecord) => Promise<Record<string, number>>;

/**
 * ゲート。skip する理由（文字列）を返すと body は呼ばれない。実行するなら null。
 * 非同期を許すのは、間隔ゲートのように判定自体が DB を読む場合があるため（searchlight-sync）。
 */
export type TenantSkipGate = (cfg: TenantConfig) => string | null | Promise<string | null>;

/**
 * 認証 → 事例の解決 → ゲート → 本体 → 記録。
 * ゲート（いつ body を呼ばず即返すか）だけを `skipReason` で外から差し込む。
 */
async function runTenantGatedJob(
  job: JobName,
  req: Request,
  body: TenantJobBody,
  skipReason: TenantSkipGate,
): Promise<Response> {
  if (!isAuthorized(req)) {
    // 認証失敗は記録しない（外部からの試行でジョブ履歴が埋まるのを防ぐ）。
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const slug = new URL(req.url).searchParams.get("tenant");
  if (!slug) return Response.json({ job, error: "tenant-required" }, { status: 400 });

  let rec: TenantRecord | null;
  try {
    rec = await getTenant(slug);
  } catch (e) {
    // 事例が引けないので事例単位の記録先が無い。ランタイムログだけが追跡手段になる。
    console.error(`[cron:${job}:${slug}] 事例の読み取りに失敗`, e);
    return Response.json({ job, tenant: slug, error: "tenant-lookup-failed" }, { status: 500 });
  }
  if (!rec) return Response.json({ job, tenant: slug, error: "tenant-not-found" }, { status: 404 });

  const cfg = resolveTenantConfig(rec);
  const startedAt = Date.now();
  let run: JobRun;

  try {
    const skipped = await skipReason(cfg);
    // skip は**実行記録を書かずに**返す。書いてしまうと job_runs.finished_at が skip 自身で
    // 前進し、間隔ゲート（isTooSoon）が毎回自分で窓を張り直して本体が永久に動かなくなる。
    // 記録を実際の試行だけに限ることで「最後にいつ本当に同期したか」も追える。
    if (skipped) return Response.json({ job, tenant: cfg.slug, skipped });

    const stats = await body(cfg, rec);
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

  // 記録の失敗でジョブの成否を覆さない。DB が落ちていても本体が成功したなら成功を返す。
  try {
    await recordRun(cfg.slug, run);
  } catch (e) {
    console.error(`[cron:${job}:${cfg.slug}] 実行記録の書き込みに失敗`, e);
  }

  if (!run.ok) console.error(`[cron:${job}:${cfg.slug}] 失敗`, run.error);

  return Response.json(
    {
      job,
      tenant: cfg.slug,
      ok: run.ok,
      durationMs: run.finishedAt - run.startedAt,
      stats: run.stats,
      error: run.error,
    },
    { status: run.ok ? 200 : 500 },
  );
}

/**
 * 通常 cron の作業ルート。事例が監視中でなければ body を呼ばず no-op
 * （dispatch が対象を絞るが、手動実行や index の遅れで来ても動かさない）。
 *
 * `extraGate` はジョブ固有の追加ゲート（省略可）。監視中の判定を通ったときだけ評価する
 * ＝監視外では追加ゲートの副作用（DB 読み取り等）も走らない。
 */
export async function runTenantCronJob(
  job: JobName,
  req: Request,
  body: TenantJobBody,
  extraGate?: TenantSkipGate,
): Promise<Response> {
  return runTenantGatedJob(job, req, body, async (cfg) => {
    if (!isTenantMonitoring(cfg)) return "not-monitoring";
    return extraGate ? await extraGate(cfg) : null;
  });
}

/**
 * 停止（shutdown）ジョブの作業ルート。ゲートが runTenantCronJob と逆で、**事例が終わってから**
 * 本体を動かす（例: 終了後に外部収集を止める）。body は冪等であること（何度叩かれても無害）。
 */
export async function runTenantShutdownJob(job: JobName, req: Request, body: TenantJobBody): Promise<Response> {
  return runTenantGatedJob(job, req, body, (cfg) =>
    cfg.status === "ended" || isTenantMonitoringEnded(cfg) ? null : "monitoring-active",
  );
}
