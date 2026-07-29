import { z } from "zod";
import { llmEnv } from "../env";

/**
 * OpenRouter への薄いトランスポート層。
 *
 * 設計上の大前提（docs/spec.md §4 冒頭）: **プロバイダは JSON Schema を無視することがある**。
 * `response_format` を送っても「強いヒント」程度にしか扱わないエンドポイントが存在しうるため、
 * ここではレスポンス形状を一切信用しない。パース → zod 検証を必ず経て、
 * スキーマ不一致は例外ではなく「よくある通常の結果」として扱う（呼び出し側に ok:false で返す）。
 *
 * 現実的な失敗パターンへの防御:
 *   - ```json ... ``` のコードフェンスで包まれる
 *   - JSON の前後に説明文（prose）が付く
 *   - 応答が途中で切れる（truncation）
 * 前二者は安全に復元できるので剥がす。truncation は安全な復元方法がない
 * （どこまでが正しい構造か推測できない）ため、素直に失敗として扱う。
 */

const OPENROUTER_ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

// OpenRouter のアプリ帰属ヘッダー（ランキング・サポート追跡用。API 動作には必須ではない）。
// 独自ドメインを取得していない運用（docs/spec.md 1章）のため固定文字列で代用する。
const HTTP_REFERER = "https://github.com/code4japan/kumamoto-birdxplorer";
const X_TITLE = "kumamoto-birdxplorer";

const DEFAULT_TIMEOUT_MS = 20_000;
/** 1回の「質問」（ask）あたりのHTTPレベル再試行回数（429/5xx/network/timeout 用）。 */
const MAX_HTTP_ATTEMPTS_PER_ASK = 3;
/**
 * 「質問」の最大回数。初回 + スキーマ不正時の再質問1回。
 * 再質問は「聞き直せば直ることが多い」という経験則に基づく、HTTP再試行とは別軸の対策。
 */
const MAX_ASKS = 2;
const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 8_000;
/**
 * 呼び出し全体の壁時計予算。Vercel serverless function には実行時間の上限があるため、
 * 個々のリトライがいくら積み重なってもここで必ず打ち切る。
 */
const MAX_TOTAL_WALL_MS = 45_000;

export type ChatJsonParams<T> = {
  /** ログ用のステージ名（"relevance" 等）。API キー以外の追跡情報として記録する。 */
  stage: string;
  systemPrompt: string;
  /** ユーザーメッセージとして JSON.stringify して送る入力データ。 */
  userPayload: unknown;
  /**
   * OpenRouter に送る JSON Schema。プロバイダが無視する可能性があるので、
   * ここは「できれば従ってほしい形」程度の位置づけ。最終的な信頼の源は zodSchema。
   */
  jsonSchema: Record<string, unknown>;
  /** response_format.json_schema.name。英数字・アンダースコア程度に留めること。 */
  schemaName: string;
  /**
   * レスポンス検証用の zod スキーマ。ここを通ったものだけが呼び出し側に渡る。
   * 個々の要素単位で失敗を許容したいステージ（Stage 1/2 のバッチ等）は、
   * ここを緩め（例: 配列の要素は unknown のまま受け取り、要素ごとの safeParse は
   * 呼び出し側で行う）に作ること。ここで弾かれた場合は「まるごと」再質問の対象になる。
   */
  zodSchema: z.ZodType<T>;
  /** 分類系（関連性判定・クラスタ割当・再編成）は 0 を指定する。レポート系は呼び出し側でやや高めに。 */
  temperature?: number;
  /** 1回のHTTPリクエストのタイムアウト（ms）。既定 20秒。 */
  timeoutMs?: number;
};

export type ChatJsonResult<T> = { ok: true; data: T } | { ok: false; reason: string };

/** 配列を size 件ずつのチャンクに分割する。大きなバッチが1リクエストに収まらないようにするため。 */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 指数バックオフ + ジッター。試行回数が増えるほど間隔を広げつつ、上限で頭打ちにする。 */
function backoffDelay(attempt: number): number {
  const base = BASE_BACKOFF_MS * 2 ** (attempt - 1);
  const jittered = base * (0.5 + Math.random() * 0.5);
  return Math.min(jittered, MAX_BACKOFF_MS);
}

/** API キーを含めない範囲でのトレース用ログ。Vercel のランタイムログがログのみの監視手段（docs/spec.md §8-7）。 */
function log(stage: string, attempt: number, message: string): void {
  console.error(`[llm:${stage}] attempt=${attempt} ${message}`);
}

const OpenRouterEnvelopeSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({ content: z.string().nullable().optional() }),
      }),
    )
    .min(1),
});

type RequestOutcome =
  | { kind: "content"; content: string }
  | { kind: "failure"; retryable: boolean; reason: string };

async function requestOnce(
  systemPrompt: string,
  userPayload: unknown,
  jsonSchema: Record<string, unknown>,
  schemaName: string,
  temperature: number,
  timeoutMs: number,
): Promise<RequestOutcome> {
  const { OPENROUTER_API_KEY, OPENROUTER_MODEL } = llmEnv();

  let res: Response;
  try {
    res = await fetch(OPENROUTER_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
        "HTTP-Referer": HTTP_REFERER,
        "X-Title": X_TITLE,
      },
      body: JSON.stringify({
        model: OPENROUTER_MODEL,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: JSON.stringify(userPayload) },
        ],
        temperature,
        response_format: {
          type: "json_schema",
          json_schema: { name: schemaName, strict: true, schema: jsonSchema },
        },
        // スキーマ非対応のエンドポイントに誤って流れないよう、OpenRouter 側で
        // パラメータ対応済みのエンドポイントだけに絞らせる（recon 済みの追加保険）。
        provider: { require_parameters: true },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const isTimeout = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    return {
      kind: "failure",
      retryable: true,
      reason: isTimeout ? "timeout" : `network error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!res.ok) {
    const retryable = res.status === 429 || res.status >= 500;
    return { kind: "failure", retryable, reason: `HTTP ${res.status}` };
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { kind: "failure", retryable: false, reason: "response body was not JSON" };
  }

  const envelope = OpenRouterEnvelopeSchema.safeParse(body);
  if (!envelope.success) {
    return { kind: "failure", retryable: false, reason: "unexpected OpenRouter response envelope" };
  }
  const content = envelope.data.choices[0]?.message.content;
  if (!content) {
    return { kind: "failure", retryable: false, reason: "empty content from model" };
  }
  return { kind: "content", content };
}

/**
 * モデル出力からJSONを安全に取り出す。
 * 復元できるのはコードフェンス除去とJSON前後の説明文除去まで。
 * truncation（途中で切れた出力）は安全に直せないため null を返し、失敗として扱わせる。
 */
function extractJson(raw: string): unknown | null {
  let text = raw.trim();

  const fenceMatch = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenceMatch) text = fenceMatch[1].trim();

  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first === -1 || last === -1 || last < first) return null;

  try {
    return JSON.parse(text.slice(first, last + 1));
  } catch {
    return null;
  }
}

/**
 * JSON Schema 指定つきで OpenRouter に問い合わせ、zod で検証した結果を返す唯一の入口。
 *
 * リトライ方針:
 *   - 429 / 5xx / ネットワークエラー / タイムアウト: 指数バックオフ+ジッターで
 *     最大 {@link MAX_HTTP_ATTEMPTS_PER_ASK} 回まで再試行
 *   - スキーマ不正な出力（パース失敗 or zod検証失敗）: 1回だけ聞き直す（再質問）
 *   - 全体の壁時計予算 {@link MAX_TOTAL_WALL_MS} を超えたら即座に打ち切る
 *     （Vercel serverless function の実行時間上限を踏まえた保険）
 *
 * 例外は投げない。呼び出し側は ok:false を「失敗ノートを retry キューに積む」等の
 * 通常フローとして扱えばよい。
 */
export async function chatJson<T>(params: ChatJsonParams<T>): Promise<ChatJsonResult<T>> {
  const { stage, systemPrompt, userPayload, jsonSchema, schemaName, zodSchema } = params;
  const temperature = params.temperature ?? 0;
  const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deadline = Date.now() + MAX_TOTAL_WALL_MS;

  let lastReason = "unknown failure";
  let totalAttempt = 0;

  for (let ask = 1; ask <= MAX_ASKS; ask++) {
    for (let httpAttempt = 1; httpAttempt <= MAX_HTTP_ATTEMPTS_PER_ASK; httpAttempt++) {
      totalAttempt++;
      if (Date.now() >= deadline) {
        log(stage, totalAttempt, `wall time budget exceeded (last: ${lastReason})`);
        return { ok: false, reason: `wall time budget exceeded (last: ${lastReason})` };
      }

      const outcome = await requestOnce(systemPrompt, userPayload, jsonSchema, schemaName, temperature, timeoutMs);

      if (outcome.kind === "failure") {
        lastReason = outcome.reason;
        log(stage, totalAttempt, `request failed: ${outcome.reason}`);
        if (!outcome.retryable || httpAttempt === MAX_HTTP_ATTEMPTS_PER_ASK) break; // この ask 内のHTTP再試行を諦め、次の ask（再質問）へ
        await sleep(backoffDelay(httpAttempt));
        continue;
      }

      const parsed = extractJson(outcome.content);
      if (parsed === null) {
        lastReason = "invalid JSON output (unparsable even after fence/prose stripping)";
        log(stage, totalAttempt, lastReason);
        break; // 次の ask（再質問）へ
      }

      const validation = zodSchema.safeParse(parsed);
      if (validation.success) {
        log(stage, totalAttempt, "ok");
        return { ok: true, data: validation.data };
      }

      lastReason = `schema validation failed: ${validation.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`;
      log(stage, totalAttempt, lastReason);
      break; // 次の ask（再質問）へ
    }
  }

  return { ok: false, reason: lastReason };
}
