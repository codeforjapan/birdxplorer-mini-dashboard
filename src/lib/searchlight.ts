import { searchlightEnv } from "./env";

/** DB 行の形。migrations/002_searchlight.sql と一致させる。 */
export type SearchlightInsightRow = {
  tweet_id: string;
  stance: "SPREADING" | "DEBUNKING" | "REPORTING" | "NEUTRAL";
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
 * claim_type / official_source_relationship は正確な enum 値集合が未確定（実API裏取り待ち、オープン事項）。
 * そのため値集合ではなく「列挙トークン形式」（大文字英数字とアンダースコアのみ、1〜64文字）を強制する。
 * RUMOR_OR_UNVERIFIED や CONFLICTS のようなトークンは通し、空白・句読点を含む AI 自由文は弾く。
 * 過剰に弾いてもバッジが出ないだけの fail-safe（既存表示への影響なし）であり、
 * 自由文を公開 Blob に載せない不変条件を優先する。
 * 注意: 実際の enum 値の大文字/記号仕様が確定したら（オープン事項）このガードを見直すこと。
 */
function isEnumToken(v: unknown): v is string {
  return typeof v === "string" && /^[A-Z0-9_]{1,64}$/.test(v);
}
/** official_source_evidence（URL文字列 or その配列）から最初の妥当な https URL を1件取る。 */
function firstUrl(v: unknown): string | null {
  const arr = Array.isArray(v) ? v : [v];
  for (const item of arr) {
    if (typeof item === "string" && /^https?:\/\//.test(item)) return item;
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

  const stance = oneOf(payload.stance, STANCES);
  const urgency = oneOf(payload.urgency, URGENCIES);
  const claimType = isEnumToken(payload.claim_type) ? payload.claim_type : null;
  const rel = isEnumToken(payload.official_source_relationship) ? payload.official_source_relationship : null;
  if (!stance || !urgency || !claimType || !rel) return null;

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
 * 対象トピックの X insight を列挙し DB 行へ整形する。
 * ※ 列挙エンドポイント・ページングはオープン事項3で確定する。ここは暫定形。
 */
export async function getInsights(now: number = Date.now()): Promise<SearchlightInsightRow[]> {
  const cfg = searchlightEnv();
  const token = await getToken();
  const res = await fetch(
    `${cfg.SEARCHLIGHT_BASE_URL}/topics/${cfg.SEARCHLIGHT_TOPIC_ID}/insights?platform=x`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  if (!res.ok) throw new Error(`Searchlight insights 取得失敗: ${res.status}`);
  const body: unknown = await res.json();
  const items = Array.isArray(body) ? body : isRecord(body) && Array.isArray(body.items) ? body.items : [];
  const rows: SearchlightInsightRow[] = [];
  for (const raw of items) {
    const row = toBadgeRow(raw, now);
    if (row) rows.push(row);
  }
  return rows;
}
