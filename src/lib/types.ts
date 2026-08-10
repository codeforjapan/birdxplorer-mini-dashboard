/**
 * 公開データのスキーマ。Blob に書き出す JSON の形はここが唯一の定義。
 *
 * 保存してはならないフィールド:
 *   - post.text        … 分類時にメモリ上でのみ扱う
 *   - post.xUser.*     … 一切保存しない
 * Vercel Blob は既定で公開読み取り可能なため、UIで非表示にするだけでは不十分。
 */

/** Searchlight の X insight（tweet_id で結合）に基づく付加バッジ。マッチした時のみ Note に存在する。 */
export type SearchlightBadge = {
  stance: "SPREADING" | "DEBUNKING" | "REPORTING" | "NEUTRAL";
  urgency: "NONE" | "LOW" | "MEDIUM" | "HIGH";
  claimType: string;
  officialRelationship: string;
  /** 公式URL（公開情報）。無ければ null。 */
  officialUrl: string | null;
};

export type NoteStatus =
  | "NEEDS_MORE_RATINGS"
  | "CURRENTLY_RATED_HELPFUL"
  | "CURRENTLY_RATED_NOT_HELPFUL";

export type Note = {
  noteId: string;
  postId: string;
  /** epoch ms */
  createdAt: number;
  /** ノート本文。公開サイトに表示する。 */
  summary: string;
  /**
   * Xポストへのリンク。`https://x.com/user/status/{postId}` の形で postId のみから組み立てる
   * （`user` はプレースホルダーで X が正しい投稿へリダイレクトする）。
   * API が返す `post.link` は投稿者の表示名を URL に含んでおり匿名化方針に反するため
   * 使わない（src/lib/birdxplorer.ts の toNote 参照）。
   */
  postUrl: string;

  // ── 評価状態（refresh-status ジョブで定期更新）──
  currentStatus: NoteStatus | null;
  helpfulCount: number;
  notHelpfulCount: number;
  rateCount: number;
  impressionCount: number | null;
  /** epoch ms。評価状態を最後に取得した時刻。 */
  statusRefreshedAt: number;

  // ── 分類結果 ──
  /** 0-100 */
  relevance: number;
  /** relevance < RELEVANCE_THRESHOLD */
  excluded: boolean;
  excludeReason: string | null;
  clusterId: string | null;
  /** epoch ms */
  classifiedAt: number;
  /** プロンプト改訂時に再分類対象を判定するため */
  classifierVersion: string;

  /**
   * Searchlight の X insight に基づく付加バッジ。tweet_id(=postId) がマッチした時のみ付く。
   * 列挙値と公式URLのみで PII を含まないため公開 Blob に載せてよい（非永続ルール順守）。
   */
  searchlight?: SearchlightBadge;
};

export type Cluster = {
  /** 永続ID ("c_001")。マージ時も削除しない。 */
  id: string;
  name: string;
  description: string;
  /** パレット添字（0-9）。採番後は変更しない。 */
  colorIndex: number;
  /** epoch ms */
  createdAt: number;
  /** マージ先のクラスタID。非nullならこのクラスタは吸収済み。 */
  aliasOf: string | null;
};

/** 30分ビン1つ分の集計。 */
export type TimelineBin = {
  /** ビン開始時刻（epoch ms）。BIN_MINUTES 幅。 */
  startAt: number;
  /** 除外ノートを含まない件数の合計。 */
  total: number;
  /** clusterId -> 件数。0件のクラスタはキーを持たない。 */
  counts: Record<string, number>;
};

// ── Blob に置く3ファイルの外枠 ──

export type NotesFile = {
  /** epoch ms */
  generatedAt: number;
  /** 除外ノート（excluded: true）も含む全件。 */
  notes: Note[];
};

export type ClustersFile = {
  generatedAt: number;
  clusters: Cluster[];
};

export type TimelineFile = {
  generatedAt: number;
  binMinutes: number;
  /** startAt 昇順。ノートが0件のビンも欠落させず埋める。 */
  bins: TimelineBin[];
};

/** 各ジョブの実行結果。KV の meta:last_run:{job} に入れる。 */
export type JobRun = {
  job: string;
  /** epoch ms */
  startedAt: number;
  finishedAt: number;
  ok: boolean;
  /** 取得・処理した件数など、ジョブごとの任意の指標。 */
  stats: Record<string, number>;
  error: string | null;
};

export type JobName = "ingest" | "recluster" | "refresh-status" | "report" | "reclassify" | "searchlight-sync";
