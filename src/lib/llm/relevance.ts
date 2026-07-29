import { z } from "zod";
import { chatJson, chunk } from "./client";
import type { LlmBatchResult, RelevanceInput, RelevanceResult } from "./contract";

/**
 * Stage 1 — 関連性判定（docs/spec.md §4 Stage 1）。
 *
 * キーワード検索（熊本 / 地震 / 津波）は OR・部分一致でノートを集めているだけなので、
 * 「熊本」や「地震」を含むだけの無関係なノートが大量に混ざる。このステージが
 * それを弾く唯一の関所であり、閾値（RELEVANCE_THRESHOLD）そのものはこのファイルの外
 * （呼び出し側）で判定する。ここは 0-100 のスコアと理由を返すところまでが責務。
 *
 * スコアが測るのは「今回の地震の被害そのものに言及しているか」ではなく、
 * 「地震をめぐる誤情報・撹乱情報を扱っているか」である。
 * 地震雲・人工地震・地震予知・過去映像の流用・避難所や外国人犯罪の噂といった言説は、
 * 今回の地震に直接言及していなくても地震のたびに繰り返し現れる。
 * それらが湧いたという事実自体がこのモニタの記録対象であるため、高く評価する。
 * 前者の狭い基準では、避難所デマのような明確な災害デマまで取りこぼしていた。
 *
 * プロンプトを改訂したら CLASSIFIER_VERSION（contract.ts）を上げること。
 * 過去に付けたスコアは「その時点のプロンプトでの判断」でしかなく、
 * 改訂後は再分類対象として扱う必要があるため。
 */

// 1リクエストに詰め込むノート数。大きすぎるとコンテキスト超過やタイムアウトのリスクが増えるため
// チャンクに分ける。1件あたり summary + postText で数百字程度を想定し、
// 25件なら要約だけでも数千トークン程度に収まり、モデルの応答（配列25要素）も
// truncation しにくいサイズに収まる。
const CHUNK_SIZE = 25;

const RELEVANCE_SYSTEM_PROMPT = `あなたは「2026年7月28日に発生した熊本地震」を起点に流通した誤情報・撹乱情報を観測するモニタの分類器です。

このモニタの目的は、地震という出来事の周辺にどのような誤った情報・人心を惑わす情報が湧いたかを記録することです。
したがって「今回の地震の被害そのものに言及しているか」だけで判断してはいけません。
地震という文脈で流通して人々の認識を歪める情報を訂正しているノートは、今回の地震に直接言及していなくても対象に含めます。

対象ノートは「熊本」「地震」「津波」という単語でのゆるい検索（OR・部分一致）で集められているため、
地震と全く無関係なノートも混入します。それを弾くことがあなたの役割です。

高いスコア（60以上の目安）にするもの:
- 今回の熊本地震に関するデマ・誤情報の訂正（被害状況、津波、断水断電などの不正確な主張）
- 義援金・寄付を騙る詐欺、公的機関になりすましたアカウントの指摘
- 過去や無関係の地震・災害の写真・動画を「今回のもの」として紐づけた投稿への指摘
- 地震にまつわる非科学的な言説への訂正（地震雲、人工地震・HAARP等の陰謀論、地震予知・予言アカウント、地震による放射線量の増加など）
  これらは今回の地震に直接言及していなくても、地震のたびに繰り返し現れる撹乱情報であり記録する価値がある
- 災害時の社会不安や差別感情を煽る情報への訂正（外国人の犯罪・窃盗団の噂、避難所運営についての作り話、寄付金の不正流用疑惑など）
- 災害対応をめぐる誤解や、公的機関・政治家の発言の誤った解釈への訂正
- 設備や自然現象について、被害や危険を誤認させる投稿への技術的な訂正
  （例: 免震装置の損傷は設計どおりの正常な挙動である、動画に映る泡は消火設備の作動である、観測波形が不自然に見えるのは震源が近いためである）

低いスコア（60未満の目安）にするもの:
- 地震と無関係な話題で、たまたま「熊本」「地震」等の語を含むだけのもの（医療・健康のデマ、アニメやイラストのAI生成判定など）
- 地震という現象そのものと関係のない統計やランキングの議論（例: 都道府県別の地震発生件数の比較）
- 誤情報の訂正を含まない、純粋な政治的論評・意見表明・政策提言
- 地震・災害と関係のない一般的な話題

各ノートについて 0-100 のスコア（relevance）と、日本語で簡潔な判断理由（reason）を1件ずつ返してください。
迷う場合は「地震の周辺で人の認識を歪める情報を扱っているなら高め、地震と無関係な話題なら低め」を目安にしてください。
過去の地震に言及していること自体を低スコアの理由にしてはいけません。判断すべきは「地震をめぐる誤情報を扱っているか」です。
入力に含まれる postText（元投稿本文）はスコアの精度を上げるための参考情報です。出力には含めないでください。
入力された note_id は1件も欠かさず、必ずすべてに対して結果を1件ずつ返してください。`;

const RESPONSE_JSON_SCHEMA = {
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

// レスポンス直下の形（results が配列であること）だけを chatJson の zod 検証で保証する。
// 個々の要素の妥当性（noteId が実在するか・値域内か等）はここでは問わず、
// 要素ごとに safeParse して合否を分ける（1件の不正な要素のせいでバッチ全体を
// 再質問扱いにしてコストを倍にしないため）。
const EnvelopeSchema = z.object({
  results: z.array(z.unknown()),
});

const ItemSchema = z.object({
  note_id: z.string().min(1),
  relevance: z.number().int().min(0).max(100),
  reason: z.string().min(1),
});

async function scoreChunk(inputs: RelevanceInput[]): Promise<LlmBatchResult<RelevanceResult>> {
  const requestedIds = new Set(inputs.map((n) => n.noteId));

  const outcome = await chatJson({
    stage: "relevance",
    systemPrompt: RELEVANCE_SYSTEM_PROMPT,
    userPayload: {
      notes: inputs.map((n) => ({ note_id: n.noteId, summary: n.summary, post_text: n.postText })),
    },
    jsonSchema: RESPONSE_JSON_SCHEMA,
    schemaName: "relevance_batch",
    zodSchema: EnvelopeSchema,
    temperature: 0,
  });

  if (!outcome.ok) {
    // このチャンクは丸ごと再試行キュー行き。呼び出し側（cron）が次回 queue:retry から拾い直す。
    return { results: [], failedNoteIds: [...requestedIds] };
  }

  const byNoteId = new Map<string, RelevanceResult>();
  for (const raw of outcome.data.results) {
    const parsed = ItemSchema.safeParse(raw);
    if (!parsed.success) continue;
    if (!requestedIds.has(parsed.data.note_id)) continue; // モデルが依頼していないIDを返してきた場合は無視
    byNoteId.set(parsed.data.note_id, {
      noteId: parsed.data.note_id,
      relevance: parsed.data.relevance,
      reason: parsed.data.reason,
    });
  }

  const results: RelevanceResult[] = [];
  const failedNoteIds: string[] = [];
  for (const noteId of requestedIds) {
    const hit = byNoteId.get(noteId);
    if (hit) results.push(hit);
    else failedNoteIds.push(noteId); // モデルが省略した・値域外だった等 → 黙って消さずキューへ
  }
  return { results, failedNoteIds };
}

export async function scoreRelevance(inputs: RelevanceInput[]): Promise<LlmBatchResult<RelevanceResult>> {
  if (inputs.length === 0) return { results: [], failedNoteIds: [] };

  const results: RelevanceResult[] = [];
  const failedNoteIds: string[] = [];
  for (const part of chunk(inputs, CHUNK_SIZE)) {
    const chunkResult = await scoreChunk(part);
    results.push(...chunkResult.results);
    failedNoteIds.push(...chunkResult.failedNoteIds);
  }
  return { results, failedNoteIds };
}
