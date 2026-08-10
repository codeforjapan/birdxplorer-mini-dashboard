import { z } from "zod";
import { env } from "./env";
import type { Note, NoteStatus } from "./types";

/**
 * BirdXplorer REST API クライアント。
 *
 * 認証は不要（OpenAPI に securitySchemes の定義なし、実測でも常に 200 が返る）。
 * レート制限は未文書化・実測でも観測されなかったが、それが「存在しない」ことの証明にはならないため
 * 429 は必ずハンドリングし、指数バックオフで自衛する（§ fetchWithRetry）。
 *
 * ここで検証するレスポンスは docs/spec.md §3.3 に列挙されたフィールドのみで、
 * それ以外は意図的に緩く（unknown keys 許容・欠損時はフォールバック）検証する。
 * 上流のAPIにフィールドが1つ増えるたびに cron 全体が落ちるような厳格スキーマは避けたい。
 * 1件の必須フィールド欠損レコードは黙ってスキップする方が、ページ全体を握り潰すより安全。
 */

// ── レスポンススキーマ（緩い検証） ──────────────────────────────

const NoteStatusSchema = z.enum([
  "NEEDS_MORE_RATINGS",
  "CURRENTLY_RATED_HELPFUL",
  "CURRENTLY_RATED_NOT_HELPFUL",
]);

// post は実測で「postId が非空でも null」になり得る（recon参照）。
// text / xUser.* はここでは型として持たせるが、Note へは絶対に渡さない
// （敢えて .loose() で unknown keys を許容しているだけで、後段の変換で明示的に拾わない）。
//
// `link` はスキーマにすら含めない。実測では `https://x.com/{投稿者の表示名}/status/{postId}`
// の形で返ってきており、表示名（本名を名乗っているアカウントもある）がそのまま URL に
// 埋め込まれている。表示名は screenName ではなく X が解決してくれる文字列ではないため
// リンクとしても壊れており（表示名に `/` が入ると path が壊れる個体を実際に観測した）、
// そのうえ匿名化方針（docs/spec.md §1 / §3.3 / §6）に反して投稿者を特定できてしまう。
// フィールドをスキーマから外すことで、うっかり `parsed.post.link` を後段で拾って
// 永続化する事故を構造的に起こせなくする。
const PostSchema = z
  .object({
    impressionCount: z.number().nullable().catch(null),
    // 分類(LLM)にのみ使う一時データ。Note には絶対に持ち込まない。splitFetchedNote 参照。
    text: z.string().nullable().catch(null),
  })
  .loose();

const SearchedNoteSchema = z
  .object({
    // ── 欠けたら使い物にならないので必須（安全側フォールバックが無意味なフィールド）──
    noteId: z.string().min(1),
    createdAt: z.number(),
    summary: z.string().min(1),

    // ── 欠けても・型が崩れても穏当なフォールバックで通す ──
    postId: z.string().catch(""),
    currentStatus: NoteStatusSchema.nullable().catch(null),
    helpfulCount: z.number().catch(0),
    notHelpfulCount: z.number().catch(0),
    rateCount: z.number().catch(0),
    post: PostSchema.nullable().catch(null),
  })
  .loose();

type SearchedNoteParsed = z.infer<typeof SearchedNoteSchema>;

const PaginationMetaSchema = z
  .object({
    next: z.string().nullable().catch(null),
    prev: z.string().nullable().catch(null),
    total: z.number().nullable().catch(null),
  })
  .loose();

// data は要素ごとに safeParse したいので、ここでは unknown[] のまま受ける
// （z.array(SearchedNoteSchema) にすると1件の不正データで配列全体が reject される）。
const SearchResponseEnvelopeSchema = z
  .object({
    data: z.array(z.unknown()),
    meta: PaginationMetaSchema,
  })
  .loose();

const NoteStatusRecordSchema = z
  .object({
    noteId: z.string().min(1),
    currentStatus: NoteStatusSchema.nullable().catch(null),
    helpfulCount: z.number().catch(0),
    notHelpfulCount: z.number().catch(0),
    rateCount: z.number().catch(0),
  })
  .loose();

const NoteListEnvelopeSchema = z
  .object({
    data: z.array(z.unknown()),
  })
  .loose();

// ── HTTP: リトライ付き fetch ─────────────────────────────────────

/**
 * 4xx（429を除く）は再試行しても無駄なので即座に投げる。
 * 429・5xx・ネットワークエラー・タイムアウトはバックオフの上リトライする。
 */
class NonRetryableHttpError extends Error {
  readonly status: number;

  constructor(status: number, url: string) {
    super(`BirdXplorer API が ${status} を返しました（リトライ対象外）: ${url}`);
    this.status = status;
  }
}

// 実測: 日付で絞らない3キーワードOR全文検索は limit=5 でも19.4秒かかった（recon参照）。
// 本番では note_created_at_from（MONITOR_START_AT）で絞るため通常はもっと速い
// （監視期間全体の457件を limit=1000 で取って約1.3秒）が、余裕を見て長めに取る。
const REQUEST_TIMEOUT_MS = 25_000;
// Vercel の関数実行時間の上限内に収めるため、バックオフを含めた合計待ち時間にも上限を設ける。
// これを超えたら諦めて例外を投げ、cron 側の次回実行に委ねる。
const MAX_TOTAL_ELAPSED_MS = 45_000;
const MAX_ATTEMPTS = 4;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 指数バックオフ + ジッター。Retry-After ヘッダがあればそちらを優先する。 */
function backoffDelayMs(attempt: number, retryAfterHeader: string | null): number {
  if (retryAfterHeader) {
    const sec = Number(retryAfterHeader);
    if (Number.isFinite(sec) && sec >= 0) return sec * 1000;
  }
  const base = 500 * 2 ** attempt; // 500ms, 1000ms, 2000ms, ...
  return base + Math.random() * base * 0.3;
}

async function fetchWithRetry(url: string): Promise<Response> {
  const deadline = Date.now() + MAX_TOTAL_ELAPSED_MS;
  let lastError: unknown;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (res.ok) return res;
      if (res.status !== 429 && res.status < 500) {
        throw new NonRetryableHttpError(res.status, url);
      }
      lastError = new Error(`BirdXplorer API が ${res.status} を返しました: ${url}`);
      if (attempt === MAX_ATTEMPTS - 1 || Date.now() >= deadline) break;
      await sleep(backoffDelayMs(attempt, res.headers.get("retry-after")));
    } catch (err) {
      if (err instanceof NonRetryableHttpError) throw err;
      lastError = err;
      if (attempt === MAX_ATTEMPTS - 1 || Date.now() >= deadline) break;
      await sleep(backoffDelayMs(attempt, null));
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`BirdXplorer API 呼び出しに失敗しました: ${String(lastError)}`);
}

/**
 * meta.next / meta.prev は実測で http:// の絶対URL（API自体はTLS終端）。
 * そのまま fetch すると毎ページ 301 リダイレクトを踏むため、事前に https:// へ書き換える。
 */
function toHttps(url: string): string {
  return url.replace(/^http:\/\//, "https://");
}

// ── 変換: API生データ → 永続化する Note ──────────────────────────

/**
 * Note に変換するための最小限の生データ。
 * post.text / post.xUser.* を型として持たない ―― searchNotes がここへ詰める時点で
 * 既に落としているため、このあと toNote に渡しても構造的に漏れようがない。
 */
export type SearchedNoteForNote = {
  noteId: string;
  postId: string;
  createdAt: number;
  summary: string;
  currentStatus: NoteStatus | null;
  helpfulCount: number;
  notHelpfulCount: number;
  rateCount: number;
  post: { impressionCount: number | null } | null;
};

/** LLM分類（Stage 1/2）の結果。toNote に渡して Note の分類フィールドを埋める。 */
export type Classification = Pick<
  Note,
  "relevance" | "excluded" | "excludeReason" | "clusterId" | "classifiedAt" | "classifierVersion"
>;

/**
 * searchNotes の1レコード。
 *
 * postText は分類(LLM)の入力にのみ使う一時データで、raw には含まれない。
 * 「raw を toNote に渡す」という自然な使い方をしている限り、postText を誤って
 * 永続化に混入させる経路が存在しない設計にしてある。呼び出し側も、分類が終わったら
 * postText への参照を保持し続けないこと（Blob はもちろん、ログにも書き出さないこと）。
 */
export type FetchedNote = {
  raw: SearchedNoteForNote;
  /** LLM分類にのみ使う投稿本文。使用後は破棄すること。toNote には渡らない。 */
  postText: string | null;
};

function splitFetchedNote(parsed: SearchedNoteParsed): FetchedNote {
  return {
    raw: {
      noteId: parsed.noteId,
      postId: parsed.postId,
      createdAt: parsed.createdAt,
      summary: parsed.summary,
      currentStatus: parsed.currentStatus,
      helpfulCount: parsed.helpfulCount,
      notHelpfulCount: parsed.notHelpfulCount,
      rateCount: parsed.rateCount,
      // impressionCount だけを明示的に取り出す（text はここで捨てる。link はそもそも
      // PostSchema に含めていないので拾いようがない）。
      post: parsed.post ? { impressionCount: parsed.post.impressionCount } : null,
    },
    postText: parsed.post?.text ?? null,
  };
}

/**
 * 生データ + 分類結果 から永続化する Note を組み立てる。
 *
 * 【プライバシー上の強制点】post.text と post.xUser.* は Note に含めてはならない
 * （docs/spec.md §6）。Vercel Blob は既定で公開読み取り可能なため、ここで漏らすと
 * そのまま外部への公開漏洩になる。SearchedNoteForNote の型自体が text/xUser を
 * 持たないので構造的に漏れないが、念のためここでもフィールドを個別に列挙し
 * （スプレッド構文を使わず）、將来 raw の型が拡張されても巻き込まれないようにする。
 *
 * 【重要】post.link は絶対に使わない（過去に使っていて公開漏洩を起こした実績あり）。
 * 実測で `post.link` は `https://x.com/{投稿者の表示名}/status/{postId}` の形式で返る。
 * screenName ではなく表示名（本名を名乗るアカウントも実在する）がそのまま URL に
 * 埋め込まれるため、匿名化方針に反して投稿者を特定できてしまう。加えて表示名に
 * `/` を含む個体を実測で観測しており、その場合はリンクとして壊れる。
 * postId だけから `https://x.com/user/status/{postId}` を組み立てる
 * （`user` は実在しないプレースホルダーだが、X 側がここへのアクセスを
 * 正しい投稿にリダイレクトするため、投稿者を特定する情報を一切埋め込まずにリンクが機能する）。
 * post が null（実測で起こり得る）でも postId さえあれば組み立てられるため postUrl は常に non-null。
 */
export function toNote(raw: SearchedNoteForNote, classification: Classification, now: number = Date.now()): Note {
  return {
    noteId: raw.noteId,
    postId: raw.postId,
    createdAt: raw.createdAt,
    summary: raw.summary,
    postUrl: `https://x.com/user/status/${raw.postId}`,

    currentStatus: raw.currentStatus,
    helpfulCount: raw.helpfulCount,
    notHelpfulCount: raw.notHelpfulCount,
    rateCount: raw.rateCount,
    impressionCount: raw.post?.impressionCount ?? null,
    statusRefreshedAt: now,

    relevance: classification.relevance,
    excluded: classification.excluded,
    excludeReason: classification.excludeReason,
    clusterId: classification.clusterId,
    classifiedAt: classification.classifiedAt,
    classifierVersion: classification.classifierVersion,
  };
}

// ── searchNotes: メインの取得経路 ─────────────────────────────────

// OR・部分一致でゆるく収集する検索語。地震周辺の言説を取りこぼさないよう拡張しており、
// 無関係なノートは Stage1 の関連性判定（relevance.ts）で弾く前提。
const SEARCH_KEYWORDS = [
  "熊本",
  "地震",
  "津波",
  "災害",
  "避難所",
  "氷川",
  "八代",
  "九州",
  "令和8年",
  "令和８年",
  "イオンモール",
  "トリアージ",
  "震度7",
  "宇城",
  "阿蘇",
  "自衛隊",
  "被災",
  "義援金",
  "募金",
  "ボランティア",
] as const;
const DEFAULT_SEARCH_LIMIT = 1000; // API の上限（limit=1001 は 422 で拒否される）
const DEFAULT_MAX_PAGES = 10;

export type SearchNotesOptions = {
  /** epoch ms。inclusive（実測で確認済み。spec.md の「exclusive」記載は誤り）。 */
  from: number;
  /** epoch ms。inclusive。省略時は最新まで。 */
  to?: number;
  /** 1ページの件数。既定・上限とも 1000。 */
  limit?: number;
  /** 追跡する最大ページ数。cron の実行時間予算に応じて呼び出し側が決める。 */
  maxPages?: number;
};

export type SearchNotesResult = {
  records: FetchedNote[];
  /**
   * note-mode / post-mode いずれかのクエリが maxPages に達してもまだ meta.next が
   * 残っていた場合 true。取得は新しい順（sort_order=desc）なので打ち切られるのは
   * 最も古い側の裾であり、新着ノートは常に1ページ目に入るため true でも取り込みは
   * 止まらない。ただし true の状態では、上流が後から追加してくる「古い createdAt を
   * 持つノート」（docs/spec.md §3.2）のうち直近 limit×maxPages 件の外に落ちるものを
   * 拾えなくなる。job_runs に記録しているので、立ったら maxPages 不足のサインとして扱う。
   */
  truncated: boolean;
};

// 1つのパラメータセットで meta.next を辿り、全ページを取得する。
// note-mode / post-mode の両方で使い回す（呼び出し側で params を差し替える）。
async function fetchAllPages(
  params: URLSearchParams,
  maxPages: number,
): Promise<{ records: FetchedNote[]; truncated: boolean }> {
  let nextUrl: string | null = `${env().BIRDXPLORER_API_BASE}/api/v1/data/search?${params.toString()}`;
  const records: FetchedNote[] = [];
  let truncated = false;
  let pageCount = 0;

  while (nextUrl) {
    pageCount++;
    const res = await fetchWithRetry(nextUrl);
    const json: unknown = await res.json();
    const envelope = SearchResponseEnvelopeSchema.parse(json);

    for (const rawItem of envelope.data) {
      const result = SearchedNoteSchema.safeParse(rawItem);
      // 必須フィールド（noteId/createdAt/summary）が欠けたレコードは黙ってスキップする。
      if (result.success) records.push(splitFetchedNote(result.data));
    }

    nextUrl = envelope.meta.next ? toHttps(envelope.meta.next) : null;
    if (nextUrl && pageCount >= maxPages) {
      truncated = true;
      break;
    }
  }

  return { records, truncated };
}

// note-mode と post-mode で共通の検索条件。キーワード指定（note_includes_text /
// post_includes_text）と search_mode だけがモード固有なので、それは呼び出し側で付ける。
function buildBaseParams(opts: SearchNotesOptions, limit: number): URLSearchParams {
  const params = new URLSearchParams();
  params.set("language", "ja");
  params.set("note_created_at_from", String(opts.from));
  if (opts.to !== undefined) params.set("note_created_at_to", String(opts.to));
  params.set("sort_field", "note_created_at");
  // 新しい順で取る。maxPages で打ち切られたときに古い裾（既に notes に入っている側）を
  // 捨てて新着を守るため。asc だと新着側へ永久に到達できず取り込みが静かに全停止する。
  params.set("sort_order", "desc");
  params.set("limit", String(limit));
  params.set("include_total", "false");
  return params;
}

// base に指定モードのキーワード条件を足す。note-mode / post-mode の唯一の差分。
// includes 系は名目上「配列」だが、実際に効くのは同名パラメータの繰り返し形式なので
// URLSearchParams.append を使う（join 等で1値にまとめると効かない。日本語キーワードの
// エンコードも append で正しく行われる）。
function withKeywords(
  base: URLSearchParams,
  includesField: "note_includes_text" | "post_includes_text",
  searchModeField: "note_search_mode" | "post_search_mode",
): URLSearchParams {
  for (const kw of SEARCH_KEYWORDS) base.append(includesField, kw);
  base.set(searchModeField, "or");
  return base;
}

/**
 * `GET /api/v1/data/search` を「ノート本文 OR 投稿本文」でキーワード検索する。
 *
 * API は note 条件（note_includes_text）と post 条件（post_includes_text）を内部で
 * AND 結合する（BirdXplorer common storage の _apply_filters）。そのため両者を同一
 * リクエストに混ぜると「note にも post にも両方含む」ものだけに絞られてしまう
 * （実測値は docs/spec.md §3.2.1）。「note 本文 OR 投稿本文」を表現するには、
 * note-mode と post-mode を別クエリで投げ、ここで noteId によりマージするしかない。
 *
 * post-mode は「投稿がキーワードを含むノート」を返すが、その投稿が BirdXplorer の
 * DB に存在するノートに限られる（post が無いノートは拾えない）。
 */
export async function searchNotes(opts: SearchNotesOptions): Promise<SearchNotesResult> {
  const limit = opts.limit ?? DEFAULT_SEARCH_LIMIT;
  const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES;

  const noteParams = withKeywords(buildBaseParams(opts, limit), "note_includes_text", "note_search_mode");
  const postParams = withKeywords(buildBaseParams(opts, limit), "post_includes_text", "post_search_mode");

  // note-mode と post-mode は独立なので並列で投げる（直列 2.6s → 並列 1.3s 程度）。
  const [noteResult, postResult] = await Promise.all([
    fetchAllPages(noteParams, maxPages),
    fetchAllPages(postParams, maxPages),
  ]);

  // noteId で重複排除して和集合を作る。note-mode を先に入れ、post-mode は未登録のみ補完
  // （同一 noteId の record は同一内容なので first-wins で等価）。
  const byNoteId = new Map<string, FetchedNote>();
  for (const r of noteResult.records) byNoteId.set(r.raw.noteId, r);
  for (const r of postResult.records) if (!byNoteId.has(r.raw.noteId)) byNoteId.set(r.raw.noteId, r);

  // 片方でも打ち切られたら取りこぼしのサインとして立てる（job_runs に記録される）。
  return {
    records: [...byNoteId.values()],
    truncated: noteResult.truncated || postResult.truncated,
  };
}

// ── fetchNoteStatuses: Stage 6 の評価状態リフレッシュ ─────────────

/**
 * `/api/v1/data/notes` から取得できる評価状態。
 * 同エンドポイントのレスポンス（`Note` スキーマ）には post が存在せず
 * impressionCount が取得できないため、ここには含めない
 * （docs/spec.md は impressionCount も更新対象と書いているが、実測ではAPIから取得不可。
 * 既存値を保持する。applyStatusRefresh 参照）。
 */
export type NoteStatusRefresh = {
  noteId: string;
  currentStatus: NoteStatus | null;
  helpfulCount: number;
  notHelpfulCount: number;
  rateCount: number;
};

// noteId は19桁固定。50件 × (「&note_ids=」10文字 + 19桁) ≈ 1,450文字。
// 一部のプロキシ/ロードバランサに実在する保守的なURL長制限（~2,000文字程度）に対し、
// ベースURLや他のクエリパラメータの余地を残すため 50 件単位に区切る。
const STATUS_BATCH_SIZE = 50;

/** noteIds をバッチ分割して評価状態だけを取得する。存在しない・見つからない ID は結果から単に欠落する。 */
export async function fetchNoteStatuses(noteIds: string[]): Promise<NoteStatusRefresh[]> {
  const out: NoteStatusRefresh[] = [];

  for (let i = 0; i < noteIds.length; i += STATUS_BATCH_SIZE) {
    const batch = noteIds.slice(i, i + STATUS_BATCH_SIZE);
    if (batch.length === 0) continue;

    const params = new URLSearchParams();
    for (const id of batch) params.append("note_ids", id);
    params.set("limit", String(batch.length));

    const url = `${env().BIRDXPLORER_API_BASE}/api/v1/data/notes?${params.toString()}`;
    const res = await fetchWithRetry(url);
    const json: unknown = await res.json();
    const envelope = NoteListEnvelopeSchema.parse(json);

    for (const rawItem of envelope.data) {
      const result = NoteStatusRecordSchema.safeParse(rawItem);
      if (result.success) {
        out.push({
          noteId: result.data.noteId,
          currentStatus: result.data.currentStatus,
          helpfulCount: result.data.helpfulCount,
          notHelpfulCount: result.data.notHelpfulCount,
          rateCount: result.data.rateCount,
        });
      }
    }
  }

  return out;
}

// ── ping ──────────────────────────────────────────────────────

export async function ping(): Promise<boolean> {
  try {
    const res = await fetchWithRetry(`${env().BIRDXPLORER_API_BASE}/api/v1/system/ping`);
    return res.ok;
  } catch {
    return false;
  }
}
