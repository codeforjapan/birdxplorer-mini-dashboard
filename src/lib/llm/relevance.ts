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
 * 判定軸は「誤情報を"訂正"しているか」ではなく「今回の熊本地震に関係するか」である。
 * 除外するのは【明確に無関係】と言い切れる話題（たまたまキーワードが混入しただけのもの）
 * の1カテゴリのみで、訂正の形をとっていない地震関連情報（被害報告・安否・義援金案内・
 * 時系列の指摘・地震絡みの政治的論評・別災害の映像の誤紐付けへの言及など）も対象に含める。
 * 「訂正」という形式で絞り込むと、地震周辺に湧いた情報を過剰に取りこぼすため。
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

const RELEVANCE_SYSTEM_PROMPT = `あなたは「2026年7月28日に発生した熊本地震」を起点に流通した情報を観測するモニタの分類器です。

このモニタの目的は、地震という出来事の周辺にどのような情報（特に誤った情報・人心を
惑わす情報）が湧いたかを幅広く記録することです。対象ノートは「熊本」「地震」「津波」
という単語でのゆるい検索（OR・部分一致）で集められているため、地震と全く無関係な
ノートも混入します。あなたの役割は、その【明確に無関係なノートだけ】を弾くことです。

重要: 「誤情報を"訂正"しているか」で判断してはいけません。今回の熊本地震に関係する
内容であれば、訂正の形をとっていなくても（被害報告・安否・義援金・時系列の指摘・
政治的論評・別災害の映像が今回のものと誤って紐付けられた件への言及など）すべて対象に
含めます。判断すべきは「今回の熊本地震に関係するか、それとも無関係な話題にたまたま
キーワードが入っただけか」の一点です。

高いスコア（60以上）にするもの — 今回の熊本地震に少しでも関係するノートすべて。例:
- 誤情報・デマの訂正（被害状況・津波・断水断電・義援金詐欺・なりすまし・過去や他災害の
  映像の誤用・地震雲/人工地震/地震予知などの非科学的言説・外国人犯罪や避難所運営の噂 など）
- 訂正の形でなくても、今回の地震に関する被害報告・犠牲者情報・安否・施設の状況・義援金の案内
- 時系列や事実関係の指摘（例:「爆発が起きたのは投稿時刻より後」といった時系列に基づく訂正）
- 今回の地震・災害対応をめぐる政治的な論評、公的機関・政治家の対応への言及や背景補足
- 別の地震・災害（能登・トルコ等）に触れていても、今回の熊本地震の文脈で流通している
  もの（過去映像の誤紐付け訂正など）

低いスコア（60未満）にするもの — 今回の熊本地震と【明確に無関係】で、たまたま「熊本」
「地震」等の語を含むだけのもの。例:
- 医療・健康のデマ、アニメやイラストのAI生成判定など、地震と関係のない話題
- 地震と無関係な政治・統計の話題（例: 市長の給与、国会議員の所属政党の統計）
- 鉄道事故など、今回の地震と関係のない事象
- 「熊本」が地名として入っているだけの、地震と無関係な一般的話題

迷う場合は【残す（高め）】に倒してください。除外は「明確に無関係」と言い切れるものだけに
限定します。

各ノートについて 0-100 のスコア（relevance）と、日本語で簡潔な判断理由（reason）を
1件ずつ返してください。入力に含まれる postText（元投稿本文）はスコアの精度を上げるための
参考情報です。出力には含めないでください。入力された note_id は1件も欠かさず、必ずすべてに
対して結果を1件ずつ返してください。`;

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
