import { z } from "zod";
import { EVENT } from "../event";
import { chatJson } from "./client";
import type { ReclusterPlan, ReportCluster } from "./contract";
import { TAXONOMY } from "./taxonomy";

/**
 * Stage 3 — 再編成（docs/spec.md §4 Stage 3、1時間ごと）。
 *
 * マージは破壊的「寄り」の操作である（元IDは消さないが aliasOf で吸収され、以後
 * 表示上は統合先に一本化される）。プロンプトは保守的にし、「本当に同じ噂」の場合だけ
 * マージを提案させる。迷ったら現状維持でよい、と明言する。
 *
 * なぜここまで保守性にこだわるか（実際の事故から得た教訓）:
 * 「イスラム教徒に配慮して避難所で豚汁を出すのをやめる」という避難所での宗教配慮を
 * めぐる噂（本来は c_033 相当）が、Stage 3 の判断で「災害時の外国人犯罪に関するデマ」
 * （c_010）に merge されたことがある。両者は「災害時のデマ」「避難所が舞台」
 * 「社会的な噂」という表層的な特徴を共有していたが、噂の中身（誰が何をしたと
 * 主張しているか）はまったく別物だった。結果、無関係な5件のノートに
 * 「外国人犯罪」という不名誉なラベルが貼られ、モニタ自身が誤った印象を
 * 作り出す事態になった。過剰統合（over-merge）は過小分割（fragmentation）より
 * 明確に有害である。分割されたままのクラスタは見た目が煩雑なだけで実害がなく、
 * 次の Stage 3 実行や手動レビューでいつでも直せる（自己修復的）。一方でマージは
 * IDが消えず表示上一本化されるため、間違いに気づくまで公開ページに
 * 誤ったラベルが出続け、かつ気づいた後も手動で alias_of を戻す作業が要る
 * （事実この巻き戻しが本ファイルの外で一度発生した）。この非対称性ゆえ、
 * プロンプトは「本当に同じ噂だと確信できないなら merge しない」を繰り返し明言し、
 * 表層的な類似だけでは統合条件を満たさないことを具体例つきで示す。
 *
 * **プランはここで厳格に検証してから返す**。ここを甘くすると、壊れたプランが
 * そのまま永続状態（KV の clusters:index）に適用され、時系列グラフの色分けが
 * 壊れたり、クラスタが循環参照で解決不能になったりする。壊れ方は「後から気づいて直す」
 * ことが難しい（マージは不可逆に近い）ため、疑わしい個々の操作は落とし、
 * プラン全体は拒否しない（＝安全な部分だけを毎時反映し続ける）方針を取る。
 * プラン全体を reject すると「1件おかしいだけで1時間分の整理が丸ごと無駄になる」という
 * 別の実害があり、個々の操作単位で弾く方が実害が小さいと判断した。
 */

const RECLUSTER_SYSTEM_PROMPT = `あなたはXコミュニティノートのクラスタ（噂の種類ごとのグループ）を整理するアシスタントです。

対象は「${EVENT.llmContextPhraseCompact}」に関する誤情報クラスタです。各クラスタには id・name・description・
所属ノート数・代表的なノート本文のサンプルが渡されます。

あなたの仕事は2つです:
1. merge（統合）: 内容が実質的に同じ噂を指しているクラスタが複数ある場合、それらを1つに統合する提案をしてください。
   統合は「元のクラスタが消えて別クラスタに吸収される」という重い操作です。
   **本当に同じ噂だと確信できる場合だけ**提案してください。同じ噂だと言えるのは、
   「誰が」「何をした（またはしなかった）」という主張の中身が一致している場合だけです。
   **表層的な類似は統合の根拠になりません。** ${TAXONOMY.overMergeCounterExample}似ているが微妙に違う噂（対象が違う、時期が違う、主張の中身が違う等）は
   統合しないでください。**判断に迷ったら、統合しないことを選んでください。** クラスタが
   分割されたままなのは見た目が煩雑になるだけの見かけ上の問題で、次回以降いつでも直せますが、
   誤った統合は無関係なノートに不適切なラベルを貼り付けたまま公開され続けるという実害を生み、
   気づかれるまで訂正されません。統合しないことのコストは、誤って統合することのコストより
   常に小さいと考えてください。
   統合先（into）は、統合される側（from）よりも代表的・説明が的確なクラスタのIDを選んでください。
2. rename（改名）: 名前が曖昧・トピック名になってしまっている・実態とずれているクラスタがあれば、
   より的確な日本語の短い名前と説明に改めてください。良い名前は「どんな噂か」を表すもの
   （例:「${TAXONOMY.clusterNamingGoodExampleSingle}」）で、単なるトピック名（例:「${TAXONOMY.clusterNamingBadExampleSingle}」）にしないでください。

制約:
- from / into / id には、渡されたクラスタ一覧に実在する id だけを使ってください。存在しないIDを作らないでください。
- 1つのクラスタを複数の統合先に振り分けたり、統合の連鎖（AをBに統合し、さらにBをCに統合する等）を
  提案しないでください。
- 変更が不要なクラスタについては何も提案しなくて構いません（merge・rename とも空配列で構いません）。`;

const RESPONSE_JSON_SCHEMA = {
  type: "object",
  properties: {
    merge: {
      type: "array",
      items: {
        type: "object",
        properties: {
          from: { type: "array", items: { type: "string" } },
          into: { type: "string" },
        },
        required: ["from", "into"],
        additionalProperties: false,
      },
    },
    rename: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          description: { type: ["string", "null"] },
        },
        required: ["id", "name", "description"],
        additionalProperties: false,
      },
    },
  },
  required: ["merge", "rename"],
  additionalProperties: false,
} as const;

// envelope レベル（merge/rename が配列であること）だけを chatJson の zod 検証で保証し、
// 個々の操作の妥当性（id の実在・循環の有無等）はプラン全体を見ないと判定できないため、
// このファイル側でまとめて検証する。
const EnvelopeSchema = z.object({
  merge: z.array(z.unknown()),
  rename: z.array(z.unknown()),
});

const MergeItemSchema = z.object({
  from: z.array(z.string().min(1)),
  into: z.string().min(1),
});

const RenameItemSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().nullable(),
});

/**
 * merge 操作群を検証・フィルタする。
 *
 * 適用する制約（docs/spec.md の要求どおり）:
 *   - すべての id は渡されたクラスタ一覧に実在すること
 *   - into は自分自身の from に含まれないこと（自己マージの禁止）
 *   - 1つの from id は（配列内・配列間を問わず）2度以上使われないこと
 *   - into が別の操作の from として使われている（＝連鎖）ことはないこと。
 *     into 集合と from 集合を互いに素に保つことで、連鎖だけでなく循環も同時に防げる
 *     （A→B→A のような循環は、B が誰かの into であり同時に誰かの from であることを
 *     禁止すれば構造的に発生しえない）。
 *
 * 個々の操作を配列の先頭から順に処理し、既に確定した from/into の集合と衝突する
 * 操作は落とす。モデルの出力順に依存するが、「先に出てきた操作を優先する」という
 * 決定的な規則であり、少なくとも不正な状態（循環・二重統合）を残さないことを保証する。
 */
function sanitizeMerge(
  rawItems: unknown[],
  validIds: ReadonlySet<string>,
): { from: string[]; into: string }[] {
  const kept: { from: string[]; into: string }[] = [];
  const claimedFrom = new Set<string>(); // 既にどこかの from として消費済みのID
  const intoTargets = new Set<string>(); // 既にどこかの into として使われているID

  for (const raw of rawItems) {
    const parsed = MergeItemSchema.safeParse(raw);
    if (!parsed.success) continue;
    const { into } = parsed.data;

    if (!validIds.has(into)) continue;
    // into が既に他の操作の from として消費されている＝連鎖になるので不採用
    if (claimedFrom.has(into)) continue;

    const from = [...new Set(parsed.data.from)].filter(
      (id) => validIds.has(id) && id !== into && !claimedFrom.has(id) && !intoTargets.has(id),
    );
    if (from.length === 0) continue;

    kept.push({ from, into });
    for (const id of from) claimedFrom.add(id);
    intoTargets.add(into);
  }
  return kept;
}

function sanitizeRename(
  rawItems: unknown[],
  validIds: ReadonlySet<string>,
  mergedAwayIds: ReadonlySet<string>,
): { id: string; name: string; description: string | null }[] {
  const seen = new Set<string>();
  const kept: { id: string; name: string; description: string | null }[] = [];

  for (const raw of rawItems) {
    const parsed = RenameItemSchema.safeParse(raw);
    if (!parsed.success) continue;
    const { id, name, description } = parsed.data;

    if (!validIds.has(id)) continue;
    if (seen.has(id)) continue; // 同じIDへの改名提案が複数あれば最初のものを優先
    // 今回同時にマージで吸収される予定のクラスタを改名しても意味がないため除外する
    if (mergedAwayIds.has(id)) continue;
    if (!name.trim()) continue;

    seen.add(id);
    kept.push({ id, name, description: description?.trim() || null });
  }
  return kept;
}

export async function planRecluster(clusters: ReportCluster[]): Promise<ReclusterPlan | null> {
  if (clusters.length === 0) return { merge: [], rename: [] }; // 整理対象がない

  const validIds = new Set(clusters.map((c) => c.clusterId));

  const outcome = await chatJson({
    stage: "recluster",
    systemPrompt: RECLUSTER_SYSTEM_PROMPT,
    userPayload: {
      clusters: clusters.map((c) => ({
        id: c.clusterId,
        name: c.name,
        description: c.description,
        note_count: c.noteCount,
        sample_summaries: c.sampleSummaries,
      })),
    },
    jsonSchema: RESPONSE_JSON_SCHEMA,
    schemaName: "recluster_plan",
    zodSchema: EnvelopeSchema,
    temperature: 0,
  });

  // 出力が丸ごと得られなかった場合は、状態を壊すリスクを避けてこの回はスキップする。
  if (!outcome.ok) return null;

  const merge = sanitizeMerge(outcome.data.merge, validIds);
  const mergedAwayIds = new Set(merge.flatMap((m) => m.from));
  const rename = sanitizeRename(outcome.data.rename, validIds, mergedAwayIds);

  return { merge, rename };
}
