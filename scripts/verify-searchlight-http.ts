/**
 * searchlight-http の検証スクリプト。
 * このリポジトリにテスト基盤は無いため（package.json の scripts 参照）、
 * fake fetch / fake sleep を注入して純ロジックを確認する使い捨てスクリプトで代替する。
 *
 * 実行: pnpm dlx tsx scripts/verify-searchlight-http.ts
 */
import assert from "node:assert/strict";
import type { SearchlightEnv } from "../src/lib/env";
import {
  createSession,
  MAX_SLEEP_MS,
  retryDelayMs,
  SearchlightBudgetExceededError,
} from "../src/lib/searchlight-http";

const ENV: SearchlightEnv = {
  SEARCHLIGHT_BASE_URL: "https://example.test/api/v1",
  SEARCHLIGHT_CLIENT_ID: "cid",
  SEARCHLIGHT_CLIENT_SECRET: "csec",
  SEARCHLIGHT_COMPANY_ID: "co",
};

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
