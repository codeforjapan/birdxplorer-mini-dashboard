import { searchlightEnv } from "./env";

/**
 * DB 行の形。migrations/002_searchlight.sql + 003_searchlight_stance_nullable.sql と一致させる。
 * stance は分析が付与しないことがある（実データで stance=null・urgency=MEDIUM・
 * official_source_relationship=insufficient_official_evidence の有用な insight を確認）ため null 許容。
 */
export type SearchlightInsightRow = {
  tweet_id: string;
  stance: "SPREADING" | "DEBUNKING" | "REPORTING" | "NEUTRAL" | null;
  urgency: "NONE" | "LOW" | "MEDIUM" | "HIGH";
  claim_type: string;
  official_source_relationship: string;
  official_source_url: string | null;
  synced_at: number;
};

const STANCES = ["SPREADING", "DEBUNKING", "REPORTING", "NEUTRAL"] as const;
const URGENCIES = ["NONE", "LOW", "MEDIUM", "HIGH"] as const;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}
function oneOf<T extends readonly string[]>(v: unknown, allowed: T): T[number] | null {
  return typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T[number]) : null;
}
/**
 * claim_type / official_source_relationship は正確な enum 値集合までは検証しない。
 * 実 API 裏取り済み: claim_type は大文字スネーク（例 RUMOR_OR_UNVERIFIED）、
 * official_source_relationship は小文字スネーク（例 conflicts_with_official_source）と大小が異なるため、
 * 値集合ではなく「列挙トークン形式」（英数字とアンダースコアのみ、1〜64文字、大小どちらも許容）を強制する。
 * 空白・句読点を含む AI 自由文だけを弾く。
 * 過剰に弾いてもバッジが出ないだけの fail-safe（既存表示への影響なし）であり、
 * 自由文を公開 Blob に載せない不変条件を優先する。
 */
function isEnumToken(v: unknown): v is string {
  return typeof v === "string" && /^[A-Za-z0-9_]{1,64}$/.test(v);
}
/**
 * official_source_evidence（`{ title, url }` オブジェクトの配列）から最初の妥当な https URL を1件取る。
 * 要素が文字列URLの場合も後方互換で許容する。unknown で受けて型ガードし、any は使わない。
 */
function firstUrl(v: unknown): string | null {
  if (!Array.isArray(v)) return null;
  for (const item of v) {
    if (typeof item === "string" && /^https?:\/\//.test(item)) return item;
    if (isRecord(item) && typeof item.url === "string" && /^https?:\/\//.test(item.url)) return item.url;
  }
  return null;
}

/**
 * Searchlight の生 insight を DB 行へ変換する。x 以外・必須列挙値欠落は null（＝保存しない）。
 * post 本文・AI 自由文は取り出さない（非永続ルール）。
 */
export function toBadgeRow(raw: unknown, now: number): SearchlightInsightRow | null {
  if (!isRecord(raw)) return null;
  if (raw.platform !== "x") return null;
  const tweetId = raw.original_post_id;
  if (typeof tweetId !== "string" || tweetId.length === 0) return null;
  const payload = raw.payload;
  if (!isRecord(payload)) return null;

  // stance は分析が付与しないことがある（実例: HAARP insight は stance=null でも
  // urgency=MEDIUM・rel=insufficient_official_evidence・公式URL付きで有用）ため任意項目にする。
  // urgency / claim_type / official_source_relationship はバッジの根拠として引き続き必須。
  const stance = oneOf(payload.stance, STANCES);
  const urgency = oneOf(payload.urgency, URGENCIES);
  const claimType = isEnumToken(payload.claim_type) ? payload.claim_type : null;
  const rel = isEnumToken(payload.official_source_relationship) ? payload.official_source_relationship : null;
  if (!urgency || !claimType || !rel) return null;

  return {
    tweet_id: tweetId,
    stance,
    urgency,
    claim_type: claimType,
    official_source_relationship: rel,
    official_source_url: firstUrl(payload.official_source_evidence),
    synced_at: now,
  };
}

const CROSS_PLATFORMS = ["youtube", "tiktok", "threads", "web"] as const;

/** 非X insight の DB 行（searchlight_cross_posts と一致）。 */
export type CrossPostRow = {
  insight_id: string;
  platform: "youtube" | "tiktok" | "threads" | "web";
  url: string;
  stance: "SPREADING" | "DEBUNKING" | "REPORTING" | "NEUTRAL" | null;
  urgency: "NONE" | "LOW" | "MEDIUM" | "HIGH";
  claim_type: string;
  official_source_relationship: string;
  official_source_url: string | null;
  claim_summary: string;
  published_at: number | null;
  synced_at: number;
};

function toEpochMs(v: unknown): number | null {
  if (typeof v !== "string") return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

/**
 * 非X の insight を DB 行へ変換する。列挙値・AI要約(claim_summary)・URL のみ抽出し、
 * 投稿本文・著者は取り出さない（非永続ルール）。stance は分析が付与しないことがあるため任意、
 * urgency/claim_type/official_source_relationship/claim_summary は必須（欠落はスキップ）。
 */
export function toCrossRow(raw: unknown, now: number): CrossPostRow | null {
  if (!isRecord(raw)) return null;
  const platform = raw.platform;
  if (typeof platform !== "string" || !(CROSS_PLATFORMS as readonly string[]).includes(platform)) return null;
  const id = raw.id;
  if (typeof id !== "string" || id.length === 0) return null;
  const url = raw.url;
  if (typeof url !== "string" || !/^https?:\/\//.test(url)) return null;
  const payload = raw.payload;
  if (!isRecord(payload)) return null;

  const stance = oneOf(payload.stance, STANCES); // null 可
  const urgency = oneOf(payload.urgency, URGENCIES);
  const claimType = isEnumToken(payload.claim_type) ? payload.claim_type : null;
  const rel = isEnumToken(payload.official_source_relationship) ? payload.official_source_relationship : null;
  const claimSummary = typeof payload.claim_summary === "string" ? payload.claim_summary.trim() : "";
  if (!urgency || !claimType || !rel || !claimSummary) return null;

  return {
    insight_id: id,
    platform: platform as CrossPostRow["platform"],
    url,
    stance,
    urgency,
    claim_type: claimType,
    official_source_relationship: rel,
    official_source_url: firstUrl(payload.official_source_evidence),
    claim_summary: claimSummary,
    published_at: toEpochMs(raw.published_at) ?? toEpochMs(raw.analyzed_at),
    synced_at: now,
  };
}

/** OAuth2 client_credentials でアクセストークンを取得する。 */
async function getToken(): Promise<string> {
  const cfg = searchlightEnv();
  const res = await fetch(`${cfg.SEARCHLIGHT_BASE_URL}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: cfg.SEARCHLIGHT_CLIENT_ID,
      client_secret: cfg.SEARCHLIGHT_CLIENT_SECRET,
    }),
  });
  if (!res.ok) throw new Error(`Searchlight token 取得失敗: ${res.status}`);
  const body: unknown = await res.json();
  if (!isRecord(body) || typeof body.access_token !== "string") {
    throw new Error("Searchlight token レスポンスが不正");
  }
  return body.access_token;
}

/**
 * レスポンス外枠から insight 配列を取り出す。
 * 実 API は bare 配列だが、将来の互換変更に備えて `{items:[]}` / `{insights:[]}` / `{data:[]}`
 * のいずれの包み方でも防御的に対応する（該当なしは空配列）。
 */
function extractItems(body: unknown): unknown[] {
  if (Array.isArray(body)) return body;
  if (!isRecord(body)) return [];
  for (const key of ["items", "insights", "data"] as const) {
    if (Array.isArray(body[key])) return body[key];
  }
  return [];
}

// insights API の1ページ上限（OpenAPI: limit は最大100）。
const PAGE_SIZE = 100;
// 暴走防止の安全上限（最大 100×50=5000件）。実運用の insight 数は数十〜数百規模。
const MAX_PAGES = 50;

/**
 * 対象会社の X insight を列挙し DB 行へ整形する。
 * 実 API 裏取り済み: insights は会社スコープ（`/companies/{id}/insights`）で、トピック直下ではない。
 *
 * ページング必須: デフォルト limit だと先頭ページ（実測10件）しか取れず、会社に56件あっても
 * ノートと重なる insight を取りこぼしてバッジが付かなかった実例がある。limit=100 で
 * 1-based page を、返る件数が1ページ上限未満（＝最終ページ）になるまで順に辿る。
 * 実測: page は 1-based で連続ページが重複なく別データを返し、範囲外 page は 4xx ではなく
 * 空配列を返す（＝最終ページ判定が効き、余分な1リクエストでも throw しない）。
 */
export async function getInsights(now: number = Date.now()): Promise<SearchlightInsightRow[]> {
  const cfg = searchlightEnv();
  const token = await getToken();
  const rows: SearchlightInsightRow[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await fetch(
      `${cfg.SEARCHLIGHT_BASE_URL}/companies/${cfg.SEARCHLIGHT_COMPANY_ID}/insights?platform=x&limit=${PAGE_SIZE}&page=${page}`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    if (!res.ok) throw new Error(`Searchlight insights 取得失敗: ${res.status}`);
    const body: unknown = await res.json();
    const items = extractItems(body);
    for (const raw of items) {
      const row = toBadgeRow(raw, now);
      if (row) rows.push(row);
    }
    // 最終ページ（1ページ上限未満）に達したら停止。
    if (items.length < PAGE_SIZE) break;
  }
  return rows;
}

/**
 * youtube/tiktok/threads/web の insight を列挙して DB 行へ整形する。
 * topic 絞りは不要（会社の insight は全件 custom トピック由来。加えて toCrossRow の
 * payload 検証で非custom は自然に除外される。実 API で検証済み）。ページングは getInsights と同一。
 */
export async function getCrossInsights(now: number = Date.now()): Promise<CrossPostRow[]> {
  const cfg = searchlightEnv();
  const token = await getToken();
  const rows: CrossPostRow[] = [];
  for (const pf of CROSS_PLATFORMS) {
    for (let page = 1; page <= MAX_PAGES; page++) {
      const res = await fetch(
        `${cfg.SEARCHLIGHT_BASE_URL}/companies/${cfg.SEARCHLIGHT_COMPANY_ID}/insights?platform=${pf}&limit=${PAGE_SIZE}&page=${page}`,
        { headers: { authorization: `Bearer ${token}` } },
      );
      if (!res.ok) throw new Error(`Searchlight ${pf} insights 取得失敗: ${res.status}`);
      const body: unknown = await res.json();
      const items = extractItems(body);
      for (const raw of items) {
        const row = toCrossRow(raw, now);
        if (row) rows.push(row);
      }
      if (items.length < PAGE_SIZE) break;
    }
  }
  return rows;
}
