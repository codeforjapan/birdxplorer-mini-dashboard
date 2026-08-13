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
  /** 分析が stance を付与しないことがあるため null 許容（src/lib/searchlight.ts 参照）。 */
  stance: "SPREADING" | "DEBUNKING" | "REPORTING" | "NEUTRAL" | null;
  urgency: "NONE" | "LOW" | "MEDIUM" | "HIGH";
  // claimType は UI が表示に使わないため公開契約から除外（データ最小化）。DB 行(SearchlightInsightRow)には残す。
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

export type CrossPlatform = "youtube" | "tiktok" | "threads" | "web";

/** 非X の Searchlight 分析結果（独立セクション用・公開 Blob に載る）。 */
export type CrossPost = {
  insightId: string;
  platform: CrossPlatform;
  url: string;
  stance: "SPREADING" | "DEBUNKING" | "REPORTING" | "NEUTRAL" | null;
  urgency: "NONE" | "LOW" | "MEDIUM" | "HIGH";
  claimType: string;
  officialRelationship: string;
  officialUrl: string | null;
  claimSummary: string;
  /** epoch ms。元投稿の公開時刻。無ければ null。 */
  publishedAt: number | null;
  // ── エンゲージメント指標 ──
  // 数値集計のみで個人特定情報ではない（著者・本文は依然として保存しない）。
  // youtube/tiktok を中心に取得でき、無いPF（web は全欠落・threads は likes のみ）では null。
  /** 表示/再生数。youtube/tiktok のみ。 */
  views?: number | null;
  /** いいね数。youtube/tiktok/threads。 */
  likes?: number | null;
  /** コメント数。youtube/tiktok のみ。 */
  comments?: number | null;
  /** シェア数。tiktok のみ。 */
  shares?: number | null;
  /** 保存数。tiktok のみ。 */
  collects?: number | null;
  /**
   * 炎上レート（Searchlight 算出の生値・0〜1）。youtube/tiktok のみ。
   * 式が PF で異なる（youtube=comments/views, tiktok=comments/likes）ため、
   * PF 横断のソート/比較には使わない（表示のみ）。
   */
  flameRate?: number | null;
};

export type CrossPostsFile = {
  generatedAt: number;
  posts: CrossPost[];
};

export type JobName = "ingest" | "recluster" | "refresh-status" | "report" | "reclassify" | "searchlight-sync";
