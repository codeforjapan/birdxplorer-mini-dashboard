import { z } from "zod";

/**
 * 環境変数の検証。
 *
 * すべて遅延評価する。モジュールのロード時点で検証すると、
 * LLM のキーを持たない環境（フロントエンドのみのローカル開発や CI ビルド）で
 * ページのビルドが落ちるため。
 *
 * 用途ごとにスキーマを分けているのも同じ理由による。
 */

const coreSchema = z.object({
  BIRDXPLORER_API_BASE: z
    .url()
    .default("https://dev.api-birdxplorer.code4japan.org")
    // 末尾スラッシュを剥がし、URL 結合時の // を防ぐ
    .transform((v) => v.replace(/\/+$/, "")),
  RELEVANCE_THRESHOLD: z.coerce.number().int().min(0).max(100).default(60),
  BLOB_READ_WRITE_TOKEN: z.string().min(1),
  /** Neon の接続文字列。ノート・クラスタ・状態すべての真実がここにある。 */
  DATABASE_URL: z.string().min(1).startsWith("postgres"),
  /** 監視開始時刻（epoch ms）。既定は 2026-07-28 13:00 JST。 */
  MONITOR_START_AT: z.coerce
    .number()
    .int()
    .default(Date.parse("2026-07-28T13:00:00+09:00")),
  /** この日付（JST）を過ぎたら cron を no-op 化する。 */
  MONITOR_END_DATE: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .default("2026-08-31"),
});

const llmSchema = z.object({
  OPENROUTER_API_KEY: z.string().min(1),
  OPENROUTER_MODEL: z.string().min(1),
});

const cronSchema = z.object({
  CRON_SECRET: z.string().min(1),
});

export type CoreEnv = z.infer<typeof coreSchema>;
export type LlmEnv = z.infer<typeof llmSchema>;

function parse<T extends z.ZodType>(schema: T, label: string): z.infer<T> {
  const result = schema.safeParse(process.env);
  if (!result.success) {
    const detail = result.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new Error(`${label} の環境変数が不正です — ${detail}`);
  }
  return result.data;
}

let coreCache: CoreEnv | undefined;
export function env(): CoreEnv {
  coreCache ??= parse(coreSchema, "コア設定");
  return coreCache;
}

let llmCache: LlmEnv | undefined;
export function llmEnv(): LlmEnv {
  llmCache ??= parse(llmSchema, "OpenRouter");
  return llmCache;
}

export function cronSecret(): string {
  return parse(cronSchema, "cron").CRON_SECRET;
}

/**
 * 運用期間を過ぎているか。cron ハンドラは真なら即 no-op で返す。
 * MONITOR_END_DATE の当日いっぱいまでは稼働させ、翌日 00:00 JST で停止する。
 */
export function isMonitoringEnded(now: number = Date.now()): boolean {
  const endExclusive = Date.parse(`${env().MONITOR_END_DATE}T00:00:00+09:00`) + 24 * 60 * 60 * 1000;
  return now >= endExclusive;
}
