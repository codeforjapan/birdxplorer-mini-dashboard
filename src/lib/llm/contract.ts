/**
 * LLM 層とそれを呼ぶ側（cron ハンドラ）の境界。
 *
 * ここは型だけを持つ。実装は同ディレクトリの各ステージに置く。
 * この契約を変えるときは呼び出し側もあわせて直す必要がある。
 */

/**
 * プロンプトを改訂したら上げる。ノートの再分類対象の判定に使う。
 *
 * v2: Stage 1 の評価軸を「今回の地震の被害への直接言及か」から
 *     「地震をめぐる誤情報・撹乱情報を扱っているか」に広げた。
 *     旧基準では地震雲・人工地震・地震予知・避難所デマなどを取りこぼしていた。
 */
export const CLASSIFIER_VERSION = "v2";

/**
 * バッチ処理の結果。
 *
 * LLM は一部の項目だけ落として返すことがあるため、成功と失敗を必ず分けて返す。
 * `failedNoteIds` は KV の `queue:retry` に積んで次回再試行する
 * （スキーマ検証に落ちた・レスポンスに含まれていなかった・値域外だった、のいずれか）。
 */
export type LlmBatchResult<T> = {
  results: T[];
  failedNoteIds: string[];
};

// ── Stage 1: 関連性判定 ──

export type RelevanceInput = {
  noteId: string;
  summary: string;
  /** 分類精度のために渡す。呼び出し側は結果を保存する際に必ず破棄する。 */
  postText: string | null;
};

export type RelevanceResult = {
  noteId: string;
  /** 0-100 */
  relevance: number;
  /** 除外理由の記録用。閾値チューニングの検証に使う。 */
  reason: string;
};

// ── Stage 2: クラスタ割当 ──

export type AssignInput = {
  noteId: string;
  summary: string;
};

/**
 * 既存クラスタへの割当か、新規クラスタの提案。
 * `kind: "new"` の場合、ID採番と colorIndex の割り当ては呼び出し側が行う
 * （LLM に永続IDを発明させない）。
 */
export type ClusterAssignment =
  | { noteId: string; kind: "existing"; clusterId: string }
  | { noteId: string; kind: "new"; name: string; description: string };

// ── Stage 3: 再編成 ──

export type ReclusterPlan = {
  /** from のクラスタに aliasOf = into を立てる。from 側のIDは削除しない。 */
  merge: { from: string[]; into: string }[];
  rename: { id: string; name: string; description: string | null }[];
};

// ── Stage 4/5: レポート ──

/** レポート生成に渡す、1クラスタぶんの要約材料。 */
export type ReportCluster = {
  clusterId: string;
  name: string;
  description: string;
  noteCount: number;
  /** 代表的なノート本文（summary のみ。postText は渡さない）。 */
  sampleSummaries: string[];
};

export type DigestInput = {
  /** 対象範囲（epoch ms）。前日15:00 JST 〜 当日15:00 JST。 */
  from: number;
  to: number;
  totalNotes: number;
  clusters: ReportCluster[];
};

/**
 * 日次ダイジェストの Markdown 構造（生成側と描画側の契約）。
 *
 * LLM の出力は自由な散文ではなく、フロントエンドが構造を解釈して
 * クラスタ別ブロック（左端にクラスタ色の縦帯）とまとめブロックを描き分ける。
 * したがって以下の形を崩さないこと。生成側は `report.ts`、
 * 描画側は `src/app/_components/ReportSection.tsx` が対応する。
 *
 * ```
 * ## クラスタ別まとめ                     ← 見出しのみ。本文は置かない
 * ### 1. {クラスタ名}（{件数}件）         ← クラスタ名で照合されるため改変しない
 * {説明本文}
 * ### 2. {クラスタ名}（{件数}件）
 * {説明本文}
 * ## まとめ                               ← 「まとめ」で始まる見出しがまとめブロックになる
 * - **{見出し語}**: {説明}
 * ```
 *
 * 描画側は見出しを `## ` / `### ` で分割し、見出し文字列からクラスタ名を
 * 部分一致で照合する。連番と `（N件）` は照合前に取り除かれるため付けてよい。
 * まとめブロックの判定は見出しの**先頭一致**で行う。
 * 「クラスタ別まとめ」のように「まとめ」を含むだけの見出しは対象外である
 * （部分一致にすると、この見出しが空のまとめカードとして描画されてしまう）。
 *
 * 累積レポート（Stage 5）はクラスタ構成が日々変わるため見出し構成を固定しない。
 * 描画側は未知の見出しを通常のセクションとして扱うので、それで問題ない。
 */
export const DIGEST_SUMMARY_HEADING = "まとめ";
