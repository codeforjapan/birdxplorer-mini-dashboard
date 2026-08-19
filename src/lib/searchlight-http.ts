import { searchlightEnv, type SearchlightEnv } from "./env";

/**
 * Searchlight への HTTP アクセスを1か所に集約する層。
 *
 * 2026-08-18〜19 に searchlight-sync が Searchlight API を約20万回呼び出した。
 * 原因は「全件取得したこと」ではなく、**全件取得を止めるものが何も無かったこと**である。
 * 仕様にも "The initial limited canary does not apply a generic per-client request limit" と
 * 明記されており、サーバ側に防壁は無い。よってここが唯一の出口になり、
 * searchlight.ts からは生の fetch を呼ばない。予算を通らない経路を作らないことが要点。
 */

/** 1実行あたりの上限。現状79・倍増しても約138なので誤爆しない値にしてある。 */
export const DEFAULT_BUDGET = 300;
/** 同一リクエストの再試行回数。 */
export const MAX_RETRIES = 2;
/** 1回の待機の上限。MAX_RETRIES との積で待機合計は60秒以内に構造的に収まる。 */
export const MAX_SLEEP_MS = 30_000;

/** 1実行の予算を使い切ったことを示す。データ量の異常な増加を知らせる警報でもある。 */
export class SearchlightBudgetExceededError extends Error {
  constructor(budget: number) {
    super(`Searchlight リクエスト予算 ${budget} を超過したため中断した`);
    this.name = "SearchlightBudgetExceededError";
  }
}

/**
 * 再試行までの待機ミリ秒。再試行しない場合は null。
 *
 * 429 と 5xx だけ再試行する。429 以外の 4xx は再送しても結果が変わらず、
 * 呼び出し回数だけが増えるため即あきらめる。
 */
export function retryDelayMs(status: number, retryAfter: string | null, attempt: number): number | null {
  if (attempt >= MAX_RETRIES) return null;
  const backoff = Math.min(1000 * 2 ** attempt, MAX_SLEEP_MS);
  if (status === 429) {
    const sec = retryAfter === null ? Number.NaN : Number(retryAfter);
    // Retry-After は秒。壊れた値・負値はサーバ都合の待機指示として使えないので指数バックオフに倒す。
    return Number.isFinite(sec) && sec > 0 ? Math.min(sec * 1000, MAX_SLEEP_MS) : backoff;
  }
  return status >= 500 ? backoff : null;
}

export type SearchlightSession = {
  /** base URL 以降のパス（クエリ込み）を渡す。例: `/companies/{id}/insights?platform=x&limit=100&page=1` */
  getJson(path: string): Promise<unknown>;
  putJson(path: string, body: unknown): Promise<void>;
  /** token 取得と再試行も含む、このセッションが送った HTTP リクエストの総数。 */
  readonly requestCount: number;
};

export type SessionOptions = {
  /** 省略時は初回リクエスト時に searchlightEnv() を遅延評価する。 */
  env?: SearchlightEnv;
  budget?: number;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * 1回の cron 実行に対して1つ作る。token をこのセッション内で共有し、
 * リクエスト数を数えて予算で打ち切る。
 */
export function createSession(opts: SessionOptions = {}): SearchlightSession {
  const budget = opts.budget ?? DEFAULT_BUDGET;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleep = opts.sleepImpl ?? defaultSleep;
  let cfg: SearchlightEnv | undefined = opts.env;
  let token: string | undefined;
  let count = 0;

  const config = (): SearchlightEnv => (cfg ??= searchlightEnv());

  /**
   * 認証ヘッダを足す前のリクエスト指定。RequestInit の headers は
   * `Headers | string[][] | Record` の union で、スプレッドすると型が壊れるため
   * 自前で使う分だけに絞る。
   */
  type JsonInit = { method: "GET" | "PUT"; headers?: Record<string, string>; body?: string };

  /** 予算を1つ消費して fetch する。予算が無ければ送信せずに throw。 */
  const send = async (url: string, init?: RequestInit): Promise<Response> => {
    if (count >= budget) throw new SearchlightBudgetExceededError(budget);
    count++;
    return fetchImpl(url, init);
  };

  const getToken = async (): Promise<string> => {
    if (token !== undefined) return token;
    const c = config();
    const res = await send(`${c.SEARCHLIGHT_BASE_URL}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: c.SEARCHLIGHT_CLIENT_ID,
        client_secret: c.SEARCHLIGHT_CLIENT_SECRET,
      }),
    });
    if (!res.ok) throw new Error(`Searchlight token 取得失敗: ${res.status}`);
    const body: unknown = await res.json();
    if (!isRecord(body) || typeof body.access_token !== "string") {
      throw new Error("Searchlight token レスポンスが不正");
    }
    token = body.access_token;
    return token;
  };

  /** 429/5xx を待って再試行する。それ以外の非 2xx は即 throw。 */
  const request = async (path: string, init: JsonInit): Promise<Response> => {
    const c = config();
    const bearer = await getToken();
    const url = `${c.SEARCHLIGHT_BASE_URL}${path}`;
    for (let attempt = 0; ; attempt++) {
      const res = await send(url, {
        ...init,
        headers: { ...init.headers, authorization: `Bearer ${bearer}` },
      });
      if (res.ok) return res;
      const delay = retryDelayMs(res.status, res.headers.get("retry-after"), attempt);
      if (delay === null) throw new Error(`Searchlight リクエスト失敗 (${path}): ${res.status}`);
      await sleep(delay);
    }
  };

  return {
    async getJson(path) {
      return (await request(path, { method: "GET" })).json();
    },
    async putJson(path, body) {
      await request(path, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    },
    get requestCount() {
      return count;
    },
  };
}
