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
  BLOB_READ_WRITE_TOKEN: z.string().min(1),
  /** Neon の接続文字列。ノート・クラスタ・状態すべての真実がここにある。 */
  DATABASE_URL: z.string().min(1).startsWith("postgres"),
});

const llmSchema = z.object({
  OPENROUTER_API_KEY: z.string().min(1),
  OPENROUTER_MODEL: z.string().min(1),
});

const cronSchema = z.object({
  CRON_SECRET: z.string().min(1),
  /**
   * 振り分け役が作業ルートを呼ぶ先（本番ドメイン）。req.url から取らないのは、
   * Deployment Protection が all_except_custom_domains だとデプロイ固有 URL への
   * 自己呼び出しが SSO で弾かれるため。
   */
  CRON_SELF_ORIGIN: z.url().transform((v) => v.replace(/\/+$/, "")),
});

const searchlightSchema = z.object({
  SEARCHLIGHT_BASE_URL: z
    .url()
    .transform((v) => v.replace(/\/+$/, "")),
  SEARCHLIGHT_CLIENT_ID: z.string().min(1),
  SEARCHLIGHT_CLIENT_SECRET: z.string().min(1),
  /** insights は会社スコープ（`/companies/{id}/insights`）で取得するため、トピックIDではなく会社IDが必要。 */
  SEARCHLIGHT_COMPANY_ID: z.string().min(1),
});

export type CoreEnv = z.infer<typeof coreSchema>;
export type LlmEnv = z.infer<typeof llmSchema>;
export type SearchlightEnv = z.infer<typeof searchlightSchema>;

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

// 作業ルートは CRON_SELF_ORIGIN を使わないので、項目ごとに検証する（未設定で認証まで落とさない）
export function cronSecret(): string {
  return parse(cronSchema.pick({ CRON_SECRET: true }), "cron").CRON_SECRET;
}

export function cronSelfOrigin(): string {
  return parse(cronSchema.pick({ CRON_SELF_ORIGIN: true }), "cron").CRON_SELF_ORIGIN;
}

let searchlightCache: SearchlightEnv | undefined;
/**
 * Searchlight の設定。searchlight-sync ジョブ実行時のみ必須。
 * 他ジョブ・ビルド時に評価しないよう遅延評価する（未設定環境を壊さない）。
 */
export function searchlightEnv(): SearchlightEnv {
  searchlightCache ??= parse(searchlightSchema, "Searchlight");
  return searchlightCache;
}

/**
 * Searchlight 連携が設定されているか。この連携はメイン機能ではなく任意の拡張であり、
 * 4つの環境変数を設定するかどうかだけでON/OFFを切り替えられるようにする
 * （vercel.json の cron 設定自体は変更不要）。searchlightEnv() と異なり例外を投げない。
 */
export function hasSearchlightConfig(): boolean {
  return searchlightSchema.safeParse(process.env).success;
}

