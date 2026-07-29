import { z } from "zod";
import { mmddhhmm } from "../time";
import { chatJson } from "./client";
import type { DigestInput } from "./contract";

/**
 * Stage 4/5 — レポート生成（docs/spec.md §4 Stage 4/5、毎日 15:00 JST）。
 *
 * どちらも失敗時は例外を投げず null を返す。呼び出し側（cron）はそれを見て
 * 「今日のレポート更新をスキップし、前日分をそのまま残す」を選べる。
 * 日次ダイジェストは確定後イミュータブル（docs/spec.md §5.2）なので、
 * 生成に失敗した回はそもそも書き込まれない方が安全。
 */

// Markdown 本文を JSON 経由で受け取る（{ markdown: string } に包む）。
// フリーテキストの Markdown をそのまま signature 保証なしで受け取るよりも、
// 「そもそも JSON として parse できるか / 期待するキーが存在するか」まで
// 検証の対象にできるため、他ステージと同じ chatJson の土台に乗せている。
// 呼び出し側（writeDailyDigest/writeCumulativeReport）が返す最終的な文字列は
// 純粋な Markdown（JSON包装なし・コードフェンスなし）になるよう、ここで剥がす。
const MarkdownResponseSchema = z.object({ markdown: z.string().min(1) });

const MARKDOWN_JSON_SCHEMA = {
  type: "object",
  properties: {
    markdown: { type: "string" },
  },
  required: ["markdown"],
  additionalProperties: false,
} as const;

/** モデルが指示に反して ```markdown ... ``` で全体を包んできた場合の保険。 */
function stripMarkdownFence(text: string): string {
  const trimmed = text.trim();
  const fenceMatch = trimmed.match(/^```(?:markdown|md)?\s*([\s\S]*?)\s*```$/i);
  return (fenceMatch ? fenceMatch[1] : trimmed).trim();
}

// ── Stage 4: 日次ダイジェスト ──

const DIGEST_SYSTEM_PROMPT = `あなたは「2026年7月28日の熊本地震」に関する誤情報モニタリングサイトの日次ダイジェストを書く記者です。
出力は日本語 Markdown 本文のみです（JSONのキーは "markdown" 1つだけで、その値が本文全体になります）。

厳守するフォーマット:
1. 冒頭に "## クラスタ別まとめ" という見出しを1つ置く。
2. その下に、渡された各クラスタについて "### {連番}. {クラスタ名}（{件数}件）" という見出しを1つずつ作り、
   直後の段落でそのクラスタが指す噂・誤情報の内容と、代表的なノート例を1-2文で要約する。
   件数が多い順に並べる。件数0件のクラスタは省略してよい。
3. 末尾に "## まとめ" という見出しを置き、その下に箇条書きで3-6項目、全体の傾向を要約する。
   各項目は "- **{見出し語}**: {説明}" の形式にし、太字にするのは冒頭の見出し語だけにする。

厳守する内容面のルール:
- 事実として断定してよいのは「渡された入力（件数・クラスタの説明・代表ノート）から読み取れる範囲」だけ。
  入力にない具体的な数字・固有名詞・時刻を作り出さない。
- このサイト自体が誤情報のデマ内容を紹介する性質上、デマの中身を紹介する際は
  「〜という投稿が確認された」「〜という主張が広がった」等、事実として発生した投稿の存在を述べる書き方にし、
  デマの内容そのものを事実であるかのように断定する書き方はしない。
- 淡々とした記録調で書く。煽り立てる表現・感嘆符は使わない。`;

export async function writeDailyDigest(input: DigestInput): Promise<string | null> {
  const rangeLabel = `${mmddhhmm(input.from)}〜${mmddhhmm(input.to)}`;

  const outcome = await chatJson({
    stage: "digest",
    systemPrompt: DIGEST_SYSTEM_PROMPT,
    userPayload: {
      range_label: rangeLabel,
      total_notes: input.totalNotes,
      clusters: [...input.clusters]
        .sort((a, b) => b.noteCount - a.noteCount)
        .map((c, i) => ({
          rank: i + 1,
          cluster_id: c.clusterId,
          name: c.name,
          description: c.description,
          note_count: c.noteCount,
          sample_summaries: c.sampleSummaries,
        })),
    },
    jsonSchema: MARKDOWN_JSON_SCHEMA,
    schemaName: "daily_digest",
    zodSchema: MarkdownResponseSchema,
    // レポート系は分類系より少し高めの温度でよい（文章としての自然さを優先する）。
    temperature: 0.4,
  });

  if (!outcome.ok) return null;
  return stripMarkdownFence(outcome.data.markdown);
}

// ── Stage 5: 累積レポート更新 ──

/**
 * 累積レポートのドリフト対策（docs/spec.md §8-1）。
 *
 * 累積レポートは「前日の累積レポート本文」を入力に取り、それに当日分を継ぎ足して
 * 上書き生成する。これを最大34日間、毎日繰り返す。つまり最終的な累積レポートは
 * 「LLMが自分の前回の出力を要約し直したものを、さらに要約し直す」を34回繰り返した産物になる
 * ―― 伝言ゲームであり、小さな歪み・断定の強まり・数字の書き換わりが複利的に蓄積しうる。
 *
 * これに対する対策は仕組みではなくプロンプトでしか効かせられない（累積レポートの
 * 正しさを機械的に検証する手段がないため）。そこで以下をプロンプトで明示的に指示する:
 *   1. 「前回の累積レポートは自由に要約し直してよい草稿ではなく、正式な記録として
 *      継続・訂正すべきもの」という位置づけを明言する（"要約し直す"ではなく"継ぎ足す"）
 *   2. 前回レポートに含まれる具体的な事実・日付・数値は、当日分と矛盾しない限り
 *      そのまま保持する（言い換えて曖昧にしない）
 *   3. ヘッジ表現（「〜という情報がある」「未確認」等）を、確認が取れていないのに
 *      断定表現（「〜であった」「判明した」）へ格上げしない
 *   4. 全体の分量に上限の目安を与え、日を追うごとに際限なく長くなることを防ぐ
 *      （古い日の記述は要点のみに圧縮してよいが、事実・数値は保持する）
 *
 * 万が一モデルが指示を無視して極端に長い出力を返しても、機械的に途中で切り詰めると
 * Markdown の見出し対応が崩れて壊れた本文になるため、ここでは切り詰めを行わない。
 * 代わりに長さを Vercel のランタイムログに記録し、運用時に気づけるようにする
 * （docs/spec.md §8-7: ログが唯一の監視手段）。
 */
const CUMULATIVE_SYSTEM_PROMPT = `あなたは「2026年7月28日の熊本地震」に関する誤情報モニタリングサイトの累積レポートを維持する編集者です。
このレポートは運用終了（2026年8月31日）まで毎日、当日分のダイジェストを継ぎ足しながら更新され続けます。
出力は日本語 Markdown 本文のみです（JSONのキーは "markdown" 1つだけで、その値が本文全体になります）。

最重要の姿勢: 渡される「前回の累積レポート」は書き直してよい下書きではなく、
これまでの正式な記録です。あなたの仕事は「要約し直す」ことではなく「継続・訂正する」ことです。
- 前回レポートに書かれている具体的な事実・日付・件数・固有名詞は、当日分の内容と明確に矛盾しない限り、
  そのまま維持してください。表現をぼかしたり、数字を書き換えたり、断定を強めたりしないでください。
- 「〜という情報がある」「未確認」「〜との報告」のようなヘッジ表現を、
  確認が取れたわけでもないのに「〜であった」「判明した」のような断定に格上げしないでください。
- 当日分のダイジェストで明確に訂正・否定された内容があれば、前回の記述を消さずに
  「後日、〜であることが確認された／誤りだったことが分かった」のように追記する形で更新してください。

構成:
- 見出しは "## 全体の推移" のような時系列を俯瞰するセクションと、
  クラスタ（噂の種類）ごとの経過をまとめたセクションで構成してください。
  クラスタ構成は日によって増減するため、固定の見出し数にこだわらなくてよいです。
- 分量は目安として全体で2000〜3000字程度に収めてください。運用期間が最大34日間続くため、
  日が経つにつれて際限なく長くなることは避けてください。古い日の詳細な経緯は要点のみに圧縮してよいですが、
  その場合も具体的な事実・数値そのものは失わないようにしてください。`;

export async function writeCumulativeReport(
  previous: string | null,
  digest: string,
  isoDay: string,
): Promise<string | null> {
  const outcome = await chatJson({
    stage: "cumulative",
    systemPrompt: CUMULATIVE_SYSTEM_PROMPT,
    userPayload: {
      iso_day: isoDay,
      previous_cumulative_report: previous, // 初日は null。その場合は当日分を土台に新規作成する。
      today_digest: digest,
    },
    jsonSchema: MARKDOWN_JSON_SCHEMA,
    schemaName: "cumulative_report",
    zodSchema: MarkdownResponseSchema,
    // 分類系よりは高いが日次ダイジェストよりやや低め。ドリフト対策の一環として
    // 創造的な言い換えを避け、できるだけ安定した出力にしたい。
    temperature: 0.2,
  });

  if (!outcome.ok) return null;

  const markdown = stripMarkdownFence(outcome.data.markdown);
  const SOFT_LENGTH_WARNING = 6_000; // 目安2000〜3000字の倍以上。ドリフトで際限なく伸びていないかの監視用。
  if (markdown.length > SOFT_LENGTH_WARNING) {
    console.error(`[llm:cumulative] output length ${markdown.length} exceeds soft warning threshold (isoDay=${isoDay})`);
  }
  return markdown;
}
