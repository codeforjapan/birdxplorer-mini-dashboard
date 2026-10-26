import { isAuthorized } from "@/lib/cron";
import { dispatchJob, selectTenantsForJob } from "@/lib/cron-dispatch";
import { cronSecret, cronSelfOrigin } from "@/lib/env";
import { readTenantIndex } from "@/lib/tenant/publish";
import type { JobName } from "@/lib/types";

export const runtime = "nodejs";

/**
 * 子（作業ルート）の完了を待つが、子が自分の maxDuration ぎりぎりまで動くと振り分け役が
 * 先に打ち切られうる。子は別の関数実行なので処理は続き、記録も子が job_runs に書く。
 * 振り分け役の応答は記録用でしかないため、打ち切られても実害は無い。
 */
export const maxDuration = 300;

/** Vercel cron から振り分ける対象。reclassify は手動の管理操作なので含めない。 */
const DISPATCH_JOBS = [
  "ingest",
  "recluster",
  "refresh-status",
  "report",
  "searchlight-sync",
  "searchlight-stop",
] as const satisfies readonly JobName[];

function isDispatchJob(v: string): v is (typeof DISPATCH_JOBS)[number] {
  return (DISPATCH_JOBS as readonly string[]).includes(v);
}

/**
 * 振り分け役。DB には触らず（監視中でない事例のために Neon を起こさない）、Blob の
 * tenants/index.json から対象の事例を選んで、事例ごとの作業ルートを呼ぶ。
 * Vercel cron は GET で叩く。
 */
export async function GET(req: Request, ctx: { params: Promise<{ job: string }> }): Promise<Response> {
  if (!isAuthorized(req)) return Response.json({ error: "unauthorized" }, { status: 401 });

  const { job } = await ctx.params;
  if (!isDispatchJob(job)) return Response.json({ error: "unknown-job", job }, { status: 404 });

  try {
    const slugs = selectTenantsForJob(job, await readTenantIndex());
    const results = await dispatchJob(job, cronSelfOrigin(), slugs, cronSecret());
    const failed = results.filter((r) => r.status !== 200);
    if (failed.length > 0) console.error(`[dispatch:${job}] 失敗した事例`, failed);
    return Response.json({ job, results });
  } catch (e) {
    console.error(`[dispatch:${job}] 失敗`, e);
    return Response.json(
      { job, error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) },
      { status: 500 },
    );
  }
}

export const POST = GET;
