import { z } from "zod";
import type { TenantConfig } from "../tenant/types";
import { chatJson, chunk } from "./client";
import type {
  LlmBatchResult,
  RelevanceInput,
  RelevanceResult,
  RelevanceVerdictResult,
} from "./contract";

/**
 * Stage 1 — 関連性判定（docs/spec.md §4 Stage 1）。
 *
 * キーワード検索（cfg.searchKeywords）は OR・部分一致でノートを集めているだけなので、
 * 検索語を含むだけの無関係なノートが大量に混ざる。このステージが
 * それを弾く唯一の関所であり、閾値（cfg.relevanceThreshold）そのものはこのファイルの外
 * （呼び出し側）で判定する。score 方式（災害型）は 0-100 のスコアと理由を、
 * binary 方式（選挙型）は related / unrelated の二値と理由を返すところまでが責務。
 *
 * 判定軸は「誤情報を"訂正"しているか」ではなく「今回の事例（cfg.llmContextPhrase）に関係するか」である。
 * 除外するのは【明確に無関係】と言い切れる話題（たまたまキーワードが混入しただけのもの）
 * の1カテゴリのみで、訂正の形をとっていない関連情報（具体例は taxonomy.relevantExamples）も対象に含める。
 * 「訂正」という形式で絞り込むと、事例の周辺に湧いた情報を過剰に取りこぼすため。
 *
 * プロンプトを改訂したら型の classifierVersion（tenant/presets.ts）を上げること。
 * 過去に付けたスコアは「その時点のプロンプトでの判断」でしかなく、
 * 改訂後は再分類対象として扱う必要があるため。
 */

// 1リクエストに詰め込むノート数。大きすぎるとコンテキスト超過やタイムアウトのリスクが増えるため
// チャンクに分ける。1件あたり summary + postText で数百字程度を想定し、
// 25件なら要約だけでも数千トークン程度に収まり、モデルの応答（配列25要素）も
// truncation しにくいサイズに収まる。
const CHUNK_SIZE = 25;

/**
 * 検索語の例は taxonomy.searchTermExamples から引く。
 * cfg.searchKeywords を直接並べる案もあるが、実際の検索語は事例固有のうえ数が多く
 * （日次で23語等）プロンプトが肥大する。taxonomy 側は「代表的な語を括弧付きで並べた文字列」で
 * 型ごとに既にレビュー済みの粒度なので、そちらを採る。
 */
function buildScorePrompt(cfg: TenantConfig): string {
  const { taxonomy } = cfg;
  const short = cfg.llmContextPhraseShort;
  return `あなたは「${cfg.llmContextPhrase}」を起点に流通した情報を観測するモニタの分類器です。

このモニタの目的は、「${short}」という出来事の周辺にどのような情報（特に誤った情報・人心を
惑わす情報）が湧いたかを幅広く記録することです。対象ノートは${taxonomy.searchTermExamples}
という単語でのゆるい検索（OR・部分一致）で集められているため、「${short}」と全く無関係な
ノートも混入します。あなたの役割は、その【明確に無関係なノートだけ】を弾くことです。

重要: 「誤情報を"訂正"しているか」で判断してはいけません。今回の${short}に関係する
内容であれば、訂正の形をとっていなくてもすべて対象に含めます。
判断すべきは「今回の${short}に関係するか、それとも無関係な話題にたまたま
キーワードが入っただけか」の一点です。

高いスコア（60以上）にするもの — 今回の${short}に少しでも関係するノートすべて。例:
${taxonomy.relevantExamples}

低いスコア（60未満）にするもの — 今回の${short}と【明確に無関係】で、たまたま
${taxonomy.searchTermExamples}等の語を含むだけのもの。例:
${taxonomy.irrelevantExamples}

迷う場合は【残す（高め）】に倒してください。除外は「明確に無関係」と言い切れるものだけに
限定します。

各ノートについて 0-100 のスコア（relevance）と、日本語で簡潔な判断理由（reason）を
1件ずつ返してください。入力に含まれる postText（元投稿本文）はスコアの精度を上げるための
参考情報です。出力には含めないでください。入力された note_id は1件も欠かさず、必ずすべてに
対して結果を1件ずつ返してください。`;
}

function buildBinaryPrompt(cfg: TenantConfig): string {
  const { taxonomy } = cfg;
  const short = cfg.llmContextPhraseShort;
  return `あなたは「${cfg.llmContextPhrase}」を起点に流通した情報を観測するモニタの分類器です。

このモニタの目的は、「${short}」という出来事の周辺にどのような情報（特に誤った情報・人心を
惑わす情報）が湧いたかを幅広く記録することです。対象ノートは${taxonomy.searchTermExamples}
という単語でのゆるい検索（OR・部分一致）で集められているため、「${short}」と全く無関係な
ノートも混入します。あなたの役割は、その【明らかに無関係なノートだけ】を弾くことです。

重要: 「誤情報を"訂正"しているか」で判断してはいけません。今回の${short}に関係する
内容であれば、訂正の形をとっていなくてもすべて対象に含めます。
判断すべきは「今回の${short}に関係するか、それとも無関係な話題にたまたま
キーワードが入っただけか」の一点です。

"related"（残す）にするもの — 今回の${short}に少しでも関係するノートすべて。例:
${taxonomy.relevantExamples}

"unrelated"（除外）にするもの — 今回の${short}と【明らかに無関係】で、たまたま
${taxonomy.searchTermExamples}等の語を含むだけのもの。例:
${taxonomy.irrelevantExamples}

判定は二値です。中間の評価やスコアは付けません。"unrelated" にしてよいのは、今回の
${short}と【明らかに無関係】だと言い切れるものだけです。少しでも関係する可能性があるもの、
関係の有無に確信が持てないもの、判断に迷うものは、すべて "related" にしてください。

各ノートについて判定（verdict: "related" または "unrelated"）と、日本語で簡潔な判断理由
（reason）を1件ずつ返してください。入力に含まれる postText（元投稿本文）は判定の精度を
上げるための参考情報です。出力には含めないでください。入力された note_id は1件も欠かさず、
必ずすべてに対して結果を1件ずつ返してください。`;
}

export function buildRelevanceSystemPrompt(cfg: TenantConfig): string {
  return cfg.relevanceMode === "binary" ? buildBinaryPrompt(cfg) : buildScorePrompt(cfg);
}

const SCORE_JSON_SCHEMA = {
  type: "object",
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        properties: {
          note_id: { type: "string" },
          relevance: { type: "integer", minimum: 0, maximum: 100 },
          reason: { type: "string" },
        },
        required: ["note_id", "relevance", "reason"],
        additionalProperties: false,
      },
    },
  },
  required: ["results"],
  additionalProperties: false,
} as const;

const BINARY_JSON_SCHEMA = {
  type: "object",
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        properties: {
          note_id: { type: "string" },
          verdict: { type: "string", enum: ["related", "unrelated"] },
          reason: { type: "string" },
        },
        required: ["note_id", "verdict", "reason"],
        additionalProperties: false,
      },
    },
  },
  required: ["results"],
  additionalProperties: false,
} as const;

// レスポンス直下の形（results が配列であること）だけを chatJson の zod 検証で保証する。
// 個々の要素の妥当性（noteId が実在するか・値域内か等）はここでは問わず、
// 要素ごとに safeParse して合否を分ける（1件の不正な要素のせいでバッチ全体を
// 再質問扱いにしてコストを倍にしないため）。
const EnvelopeSchema = z.object({
  results: z.array(z.unknown()),
});

const ScoreItemSchema = z.object({
  note_id: z.string().min(1),
  relevance: z.number().int().min(0).max(100),
  reason: z.string().min(1),
});

// verdict は enum の完全一致のみ通す。表記ゆれ（"Related" 等）を握りつぶして
// 片側に倒すと、判定の誤りが除外として静かに確定してしまうため、
// 落として再試行キューへ送る方を選ぶ。
const VerdictItemSchema = z.object({
  note_id: z.string().min(1),
  verdict: z.enum(["related", "unrelated"]),
  reason: z.string().min(1),
});

/**
 * 1チャンク分の問い合わせと、要素ごとの検証・欠落検出。score / binary で違うのは
 * プロンプト・スキーマ・要素の変換だけなので、ここを共通化する。
 */
async function askChunk<R extends { noteId: string }>(
  cfg: TenantConfig,
  inputs: RelevanceInput[],
  jsonSchema: Record<string, unknown>,
  parseItem: (raw: unknown) => R | null,
): Promise<LlmBatchResult<R>> {
  const requestedIds = new Set(inputs.map((n) => n.noteId));

  const outcome = await chatJson({
    attribution: { githubRepo: cfg.githubRepo, appTitle: cfg.appTitle },
    stage: "relevance",
    systemPrompt: buildRelevanceSystemPrompt(cfg),
    userPayload: {
      notes: inputs.map((n) => ({ note_id: n.noteId, summary: n.summary, post_text: n.postText })),
    },
    jsonSchema,
    schemaName: "relevance_batch",
    zodSchema: EnvelopeSchema,
    temperature: 0,
  });

  if (!outcome.ok) {
    // このチャンクは丸ごと再試行キュー行き。呼び出し側（cron）が次回 queue:retry から拾い直す。
    return { results: [], failedNoteIds: [...requestedIds] };
  }

  const byNoteId = new Map<string, R>();
  for (const raw of outcome.data.results) {
    const item = parseItem(raw);
    if (!item) continue;
    if (!requestedIds.has(item.noteId)) continue; // モデルが依頼していないIDを返した場合は無視
    byNoteId.set(item.noteId, item);
  }

  const results: R[] = [];
  const failedNoteIds: string[] = [];
  for (const noteId of requestedIds) {
    const hit = byNoteId.get(noteId);
    if (hit) results.push(hit);
    else failedNoteIds.push(noteId); // モデルが省略した・値域外だった等 → 黙って消さずキューへ
  }
  return { results, failedNoteIds };
}

async function askAll<R extends { noteId: string }>(
  cfg: TenantConfig,
  inputs: RelevanceInput[],
  jsonSchema: Record<string, unknown>,
  parseItem: (raw: unknown) => R | null,
): Promise<LlmBatchResult<R>> {
  if (inputs.length === 0) return { results: [], failedNoteIds: [] };

  const results: R[] = [];
  const failedNoteIds: string[] = [];
  for (const part of chunk(inputs, CHUNK_SIZE)) {
    const chunkResult = await askChunk(cfg, part, jsonSchema, parseItem);
    results.push(...chunkResult.results);
    failedNoteIds.push(...chunkResult.failedNoteIds);
  }
  return { results, failedNoteIds };
}

/** score 方式（災害型）。0-100 のスコアを返す。 */
export function scoreRelevance(cfg: TenantConfig, inputs: RelevanceInput[]): Promise<LlmBatchResult<RelevanceResult>> {
  return askAll(cfg, inputs, SCORE_JSON_SCHEMA, (raw) => {
    const p = ScoreItemSchema.safeParse(raw);
    return p.success ? { noteId: p.data.note_id, relevance: p.data.relevance, reason: p.data.reason } : null;
  });
}

/** binary 方式（選挙型）。related / unrelated の二値を返す。 */
export function judgeRelevance(
  cfg: TenantConfig,
  inputs: RelevanceInput[],
): Promise<LlmBatchResult<RelevanceVerdictResult>> {
  return askAll(cfg, inputs, BINARY_JSON_SCHEMA, (raw) => {
    const p = VerdictItemSchema.safeParse(raw);
    return p.success ? { noteId: p.data.note_id, verdict: p.data.verdict, reason: p.data.reason } : null;
  });
}
