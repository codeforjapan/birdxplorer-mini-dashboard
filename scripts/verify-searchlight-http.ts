/**
 * searchlight-http の検証スクリプト。
 * このリポジトリにテスト基盤は無いため（package.json の scripts 参照）、
 * fake fetch / fake sleep を注入して純ロジックを確認する使い捨てスクリプトで代替する。
 *
 * 実行: pnpm dlx tsx scripts/verify-searchlight-http.ts
 */
import assert from "node:assert/strict";
import { isForceRequested, isTooSoon, MIN_SYNC_INTERVAL_MS } from "../src/lib/cron";
import type { SearchlightEnv } from "../src/lib/env";
import { getInsights } from "../src/lib/searchlight";
import {
  createSession,
  MAX_SLEEP_MS,
  retryDelayMs,
  SearchlightBudgetExceededError,
  type SearchlightSession,
} from "../src/lib/searchlight-http";
import type { JobRun } from "../src/lib/types";

const ENV: SearchlightEnv = {
  SEARCHLIGHT_BASE_URL: "https://example.test/api/v1",
  SEARCHLIGHT_CLIENT_ID: "cid",
  SEARCHLIGHT_CLIENT_SECRET: "csec",
  SEARCHLIGHT_COMPANY_ID: "co",
};

// searchlight.ts のページングは searchlightEnv() で会社IDを読む。session を fake に
// 差し替えるので実 API は叩かない＝ダミー値で足りる。
Object.assign(process.env, ENV);

const TOKEN_BODY = { access_token: "T", token_type: "Bearer", expires_in: 3600, scope: "read" };

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** 台本どおりに Response を返す fake fetch。呼ばれた URL と回数を記録する。 */
function fakeFetch(script: readonly (() => Response)[]) {
  const urls: string[] = [];
  const queue = [...script];
  const impl = (async (input: string | URL | Request): Promise<Response> => {
    urls.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const next = queue.shift();
    if (!next) throw new Error(`台本外の追加リクエストが発生した: ${urls[urls.length - 1]}`);
    return next();
  }) as unknown as typeof fetch;
  return { impl, urls };
}

/**
 * insights ページングの fake session。page <= fullPages は満杯（1ページ上限の100件）を返し、
 * それ以降は3件だけ返す（＝最終ページ）。fullPages=50 なら MAX_PAGES 打ち切りを再現する。
 */
function fakeInsightSession(fullPages: number): { session: SearchlightSession; pages: number[] } {
  const pages: number[] = [];
  let count = 0;
  const item = (i: number): unknown => ({
    platform: "x",
    original_post_id: `t${i}`,
    payload: {
      urgency: "LOW",
      claim_type: "RUMOR_OR_UNVERIFIED",
      official_source_relationship: "no_official_source",
    },
  });
  const session: SearchlightSession = {
    async getJson(path: string): Promise<unknown> {
      count++;
      const page = Number(new URL(`https://example.test${path}`).searchParams.get("page"));
      pages.push(page);
      const size = page <= fullPages ? 100 : 3;
      return Array.from({ length: size }, (_, i) => item(page * 100 + i));
    },
    async putJson(): Promise<void> {
      throw new Error("この検証では putJson を使わない");
    },
    get requestCount(): number {
      return count;
    },
  };
  return { session, pages };
}

function fakeSleep() {
  const waited: number[] = [];
  return { waited, impl: async (ms: number): Promise<void> => void waited.push(ms) };
}

const checks: [string, () => Promise<void> | void][] = [
  [
    "1: token は1セッションで1回しか取得しない",
    async () => {
      const { impl, urls } = fakeFetch([() => json(TOKEN_BODY), () => json([1]), () => json([2])]);
      const s = createSession({ env: ENV, fetchImpl: impl });
      await s.getJson("/a");
      await s.getJson("/b");
      assert.equal(urls.length, 3);
      assert.equal(urls.filter((u) => u.endsWith("/oauth/token")).length, 1);
      assert.equal(s.requestCount, 3, "token 取得もカウント対象");
    },
  ],
  [
    "2: 予算を超えたら SearchlightBudgetExceededError（超過分は fetch しない）",
    async () => {
      const { impl, urls } = fakeFetch([() => json(TOKEN_BODY), () => json([1])]);
      const s = createSession({ env: ENV, fetchImpl: impl, budget: 2 });
      await s.getJson("/a");
      await assert.rejects(() => s.getJson("/b"), SearchlightBudgetExceededError);
      assert.equal(urls.length, 2, "予算超過のリクエストは送信されない");
    },
  ],
  [
    "3: 429 は Retry-After 秒だけ待って再試行する",
    async () => {
      const { impl } = fakeFetch([
        () => json(TOKEN_BODY),
        () => json({ title: "Too Many Requests" }, 429, { "retry-after": "3" }),
        () => json([1]),
      ]);
      const sleep = fakeSleep();
      const s = createSession({ env: ENV, fetchImpl: impl, sleepImpl: sleep.impl });
      assert.deepEqual(await s.getJson("/a"), [1]);
      assert.deepEqual(sleep.waited, [3000]);
    },
  ],
  [
    "4: Retry-After が無い429は指数バックオフ（1秒）",
    async () => {
      const { impl } = fakeFetch([
        () => json(TOKEN_BODY),
        () => json({}, 429),
        () => json([1]),
      ]);
      const sleep = fakeSleep();
      const s = createSession({ env: ENV, fetchImpl: impl, sleepImpl: sleep.impl });
      await s.getJson("/a");
      assert.deepEqual(sleep.waited, [1000]);
    },
  ],
  [
    "5: 429 が続いても最大2回しか再試行せず throw する",
    async () => {
      const { impl, urls } = fakeFetch([
        () => json(TOKEN_BODY),
        () => json({}, 429),
        () => json({}, 429),
        () => json({}, 429),
      ]);
      const sleep = fakeSleep();
      const s = createSession({ env: ENV, fetchImpl: impl, sleepImpl: sleep.impl });
      await assert.rejects(() => s.getJson("/a"), /429/);
      assert.equal(urls.length, 4, "token1 + 本体3回（初回+再試行2回）");
      assert.deepEqual(sleep.waited, [1000, 2000]);
    },
  ],
  [
    "6: 5xx は再試行するが 429 以外の4xxは即 throw",
    async () => {
      const retry = fakeFetch([() => json(TOKEN_BODY), () => json({}, 503), () => json([1])]);
      const sleepA = fakeSleep();
      const a = createSession({ env: ENV, fetchImpl: retry.impl, sleepImpl: sleepA.impl });
      await a.getJson("/a");
      assert.deepEqual(sleepA.waited, [1000], "503 は再試行する");

      const fail = fakeFetch([() => json(TOKEN_BODY), () => json({}, 400)]);
      const sleepB = fakeSleep();
      const b = createSession({ env: ENV, fetchImpl: fail.impl, sleepImpl: sleepB.impl });
      await assert.rejects(() => b.getJson("/a"), /400/);
      assert.deepEqual(sleepB.waited, [], "400 は待たずに即 throw");
    },
  ],
  [
    "7: 1回の待機は30秒を超えない",
    () => {
      assert.equal(retryDelayMs(429, "120", 0), MAX_SLEEP_MS);
      assert.equal(retryDelayMs(429, "3", 0), 3000);
      assert.equal(retryDelayMs(429, null, 1), 2000);
      assert.equal(retryDelayMs(503, null, 0), 1000);
      assert.equal(retryDelayMs(400, null, 0), null, "4xx は再試行しない");
      assert.equal(retryDelayMs(429, "3", 2), null, "MAX_RETRIES に達したら再試行しない");
      assert.equal(retryDelayMs(429, "abc", 0), 1000, "壊れた Retry-After は指数バックオフに倒す");
      assert.equal(retryDelayMs(429, "-5", 0), 1000, "負の Retry-After も指数バックオフに倒す");
    },
  ],
  [
    "8: putJson も予算を消費する",
    async () => {
      const { impl, urls } = fakeFetch([() => json(TOKEN_BODY), () => new Response(null, { status: 200 })]);
      const s = createSession({ env: ENV, fetchImpl: impl });
      await s.putJson("/t", { a: 1 });
      assert.equal(s.requestCount, 2);
      assert.ok(urls[1].startsWith("https://example.test/api/v1/t"));
    },
  ],
  [
    "9: 間隔ゲートは最後の試行から数える（成否を問わない）",
    () => {
      const now = 1_000_000_000_000;
      const run = (ok: boolean, finishedAt: number): JobRun => ({
        job: "searchlight-sync",
        startedAt: finishedAt - 1000,
        finishedAt,
        ok,
        stats: {},
        error: null,
      });
      const h = (n: number) => n * 60 * 60 * 1000;
      assert.equal(isTooSoon(null, now, MIN_SYNC_INTERVAL_MS), false, "記録が無ければ実行する");
      assert.equal(isTooSoon(run(true, now - h(2)), now, MIN_SYNC_INTERVAL_MS), true);
      assert.equal(isTooSoon(run(true, now - h(21)), now, MIN_SYNC_INTERVAL_MS), false);
      // ok=false でも間隔を消費する。恒久的な失敗と cron 頻度の巻き戻しが重なったときに
      // 48回すべてが通過して事故が再現するのを防ぐため。
      assert.equal(isTooSoon(run(false, now - h(2)), now, MIN_SYNC_INTERVAL_MS), true);
      assert.equal(isTooSoon(run(false, now - h(21)), now, MIN_SYNC_INTERVAL_MS), false);
    },
  ],
  [
    "10: 間隔は20時間（24時間だと日次 cron が1日飛ぶ）",
    () => {
      assert.equal(MIN_SYNC_INTERVAL_MS, 20 * 60 * 60 * 1000);
    },
  ],
  [
    "11: ?force=1 だけがゲートを飛ばす（cron 経路＝クエリ無しは飛ばさない）",
    () => {
      const u = (q: string) => `https://dash.test/api/cron/searchlight-sync${q}`;
      // Vercel cron はクエリ無しで叩く。ここが false であることが日次上限の不変条件の土台。
      assert.equal(isForceRequested(u("")), false, "クエリ無しでは飛ばさない");
      assert.equal(isForceRequested(u("?force=1")), true);
      assert.equal(isForceRequested(u("?a=b&force=1")), true, "他のクエリと併用しても効く");
      // 逃げ道は意図的に狭い。=1 の厳密比較なので下は効かない（仕様として固定する）。
      assert.equal(isForceRequested(u("?force=true")), false, "true では効かない");
      assert.equal(isForceRequested(u("?force")), false, "値なしでは効かない");
      assert.equal(isForceRequested(u("?force=0")), false);
      assert.equal(isForceRequested(u("?forced=1")), false);
    },
  ],
  [
    "12: 安全上限での打ち切りを truncated で返す（最終ページ到達と区別する）",
    async () => {
      const hitLimit = fakeInsightSession(50);
      const truncated = await getInsights(hitLimit.session, 0);
      assert.equal(truncated.truncated, true, "満杯のまま MAX_PAGES を使い切ったら打ち切り");
      assert.equal(hitLimit.pages.length, 50, "MAX_PAGES を超えてページを叩かない");
      assert.equal(truncated.rows.length, 5000);

      const lastPage = fakeInsightSession(1);
      const complete = await getInsights(lastPage.session, 0);
      assert.equal(complete.truncated, false, "1ページ上限未満が返ったら正常終了");
      assert.equal(lastPage.pages.length, 2);
      assert.equal(complete.rows.length, 103);
    },
  ],
];

async function main(): Promise<void> {
  let failed = 0;
  for (const [name, fn] of checks) {
    try {
      await fn();
      console.log(`  ok   ${name}`);
    } catch (e) {
      failed++;
      console.error(`  FAIL ${name}\n       ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  console.log(failed === 0 ? `\n全 ${checks.length} 件 ok` : `\n${failed} 件失敗`);
  process.exit(failed === 0 ? 0 : 1);
}

void main();
