import { searchlightEnv } from "./env";
import type { SearchlightSession } from "./searchlight-http";

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

// ── 収集停止（アーカイブ時）─────────────────────────────────
// MONITOR_END_DATE を過ぎたら収集を止めるための純ロジック。特定トピックIDを知らずとも、
// 「収集が有効なトピック」を列挙して無効化計画に落とす（会社の全イベントトピックが対象）。

type PlatformCollectionConfig = { enabled?: boolean; [k: string]: unknown };
type TopicCollectionConfig = { enabled: boolean; platforms: PlatformCollectionConfig[]; [k: string]: unknown };
/** 1トピック分の無効化 PUT 計画。collectionConfig はそのまま `{collectionConfig}` として送れる。 */
export type ShutdownPlan = { topicId: string; collectionConfig: TopicCollectionConfig };

/**
 * collectionConfig を型ガードする。platforms はオブジェクト要素だけ残す（非オブジェクトの
 * ゴミのみ除外）。有効な platform を PUT body から落とさないため、enabled 欠落でも要素は保持する
 * （後段で enabled=false を付与する）。
 */
function asTopicConfig(v: unknown): TopicCollectionConfig | null {
  if (!isRecord(v) || typeof v.enabled !== "boolean" || !Array.isArray(v.platforms)) return null;
  const platforms = v.platforms.filter(isRecord) as PlatformCollectionConfig[];
  return { ...v, enabled: v.enabled, platforms };
}

/**
 * トピック一覧（`GET /companies/{co}/topics` の生レスポンス）から、収集が有効なトピックだけを
 * 「無効化 PUT 計画」に変換する純関数。トピック本体 enabled やその他フィールドは触らず、
 * collectionConfig.enabled と全 PF の enabled を false に落とすだけ（web の mrd 等は現状維持＝
 * ①で踏んだ "web は metadata refresh 非対応" 400 を避ける）。何も有効でなければ空配列（完全 no-op）。
 */
export function planCollectionShutdown(topicsRaw: unknown): ShutdownPlan[] {
  const topics = extractItems(topicsRaw);
  const plans: ShutdownPlan[] = [];
  for (const t of topics) {
    if (!isRecord(t) || typeof t.id !== "string") continue;
    const cc = asTopicConfig(t.collectionConfig);
    if (!cc) continue;
    const anyEnabled = cc.enabled || cc.platforms.some((p) => p.enabled === true);
    if (!anyEnabled) continue;
    plans.push({
      topicId: t.id,
      collectionConfig: { ...cc, enabled: false, platforms: cc.platforms.map((p) => ({ ...p, enabled: false })) },
    });
  }
  return plans;
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

export const CROSS_PLATFORMS = ["youtube", "tiktok", "threads", "web"] as const;
export type CrossPlatform = (typeof CROSS_PLATFORMS)[number];

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
  // ── エンゲージメント指標（raw.metrics 由来。数値集計のみ・個人特定情報ではない）──
  // 取得できるフィールドは PF で偏る（web は全欠落・threads は likes のみ・shares/collects は tiktok のみ）。
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  collects: number | null;
  /** 炎上レート（Searchlight 算出の生値 0〜1・youtube/tiktok のみ）。式が PF で異なり横断比較しない。 */
  flame_rate: number | null;
};

/** raw.metrics の数値を取り出す。数値以外（欠落・null・文字列）は null に倒す。 */
function metricNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

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

  // 指標は payload ではなく item 直下の metrics に入る。無いPF・欠落は null。
  const metrics = isRecord(raw.metrics) ? raw.metrics : {};

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
    views: metricNumber(metrics.views),
    likes: metricNumber(metrics.likes),
    comments: metricNumber(metrics.comments),
    shares: metricNumber(metrics.shares),
    collects: metricNumber(metrics.collects),
    flame_rate: metricNumber(metrics.flame_rate),
  };
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
// 暴走防止の安全上限（1PFあたり最大 100×50=5000件）。実測（2026-08-19）は5PF計7,757件で、
// 最大の web が 4,652件=47ページ＝上限まで残り約7%しかない。収集を再開すれば web は
// この上限に当たる。当たったことは truncated で呼び出し側に返す（無言で落とさない）。
const MAX_PAGES = 50;

/** 1PF分の取得結果。truncated は MAX_PAGES で打ち切った＝データを落とした可能性を表す。 */
export type InsightPage<T> = { rows: T[]; truncated: boolean };

/**
 * insights を platform で絞ってページングし、map が返した行だけを集める。
 * getInsights と getCrossInsightsFor でループが完全に同一だったため共通化した。
 * ページング仕様（limit=100・1-based・返却が上限未満で終了）は変えていない。
 *
 * 実 API 裏取り済み: insights は会社スコープ（`/companies/{id}/insights`）で、トピック直下ではない。
 * ページング必須: デフォルト limit だと先頭ページ（実測10件）しか取れず、会社に56件あっても
 * ノートと重なる insight を取りこぼしてバッジが付かなかった実例がある。limit=100 で
 * 1-based page を、返る件数が1ページ上限未満（＝最終ページ）になるまで順に辿る。
 * 実測: page は 1-based で連続ページが重複なく別データを返し、範囲外 page は 4xx ではなく
 * 空配列を返す（＝最終ページ判定が効き、余分な1リクエストでも throw しない）。
 *
 * 呼び出し回数の上限は session の予算が握る（searchlight-http.ts 参照）。
 */
async function collectInsightPages<T>(
  session: SearchlightSession,
  platform: string,
  map: (raw: unknown) => T | null,
): Promise<InsightPage<T>> {
  const cfg = searchlightEnv();
  const rows: T[] = [];
  let truncated = false;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const body = await session.getJson(
      `/companies/${cfg.SEARCHLIGHT_COMPANY_ID}/insights?platform=${platform}&limit=${PAGE_SIZE}&page=${page}`,
    );
    const items = extractItems(body);
    for (const raw of items) {
      const row = map(raw);
      if (row) rows.push(row);
    }
    // ループの終わり方は2種類あり、意味が正反対なので区別する。
    // (a) 1ページ上限未満が返った＝最終ページに到達（正常・全件取得できた）
    // (b) 満杯のまま MAX_PAGES を使い切った＝安全上限での打ち切り（残りを落としている）
    // 区別せずに break すると (b) が無言のデータ欠落になり、集計値が理由なくずれる。
    if (items.length < PAGE_SIZE) break;
    if (page === MAX_PAGES) truncated = true;
  }
  return { rows, truncated };
}

/** 対象会社の X insight を列挙し DB 行へ整形する。ページング仕様は collectInsightPages 参照。 */
export async function getInsights(
  session: SearchlightSession,
  now: number = Date.now(),
): Promise<InsightPage<SearchlightInsightRow>> {
  return collectInsightPages(session, "x", (raw) => toBadgeRow(raw, now));
}

/**
 * 1プラットフォーム分の非X insight を列挙して DB 行へ整形する。
 *
 * PF 単位に分けているのは、呼び出し側が「1PF取得 → upsert」を繰り返せるようにするため。
 * 4PF・数千件を全部メモリに集めてから最後に1回 upsert すると、途中でタイムアウトしたときに
 * 進捗がゼロになる（cron/ingest/route.ts の注意書きと同じ問題）。分割すれば失うのは最大1PF分で、
 * upsert は insight_id 冪等なので次回実行で収束する。
 *
 * topic 絞りは不要（会社の insight は全件 custom トピック由来。加えて toCrossRow の
 * payload 検証で非custom は自然に除外される。実 API で検証済み）。
 */
export async function getCrossInsightsFor(
  session: SearchlightSession,
  platform: CrossPlatform,
  now: number = Date.now(),
): Promise<InsightPage<CrossPostRow>> {
  return collectInsightPages(session, platform, (raw) => toCrossRow(raw, now));
}

/**
 * 会社の収集を停止する（アーカイブ時）。有効なトピックの collectionConfig を無効化 PUT する。
 * 特定トピックIDは不要（`planCollectionShutdown` が有効トピックを見つける）。冪等＝有効トピックが
 * 無ければ何もせず 0 を返す。PUT は `TopicRequest` の部分更新で、body は `{collectionConfig}` だけ送る
 * （`transcriptionPrompt:null` を含めると 400 になるため）。返り値の topicsDisabled は実際に PUT した数。
 */
export async function disableCollection(session: SearchlightSession): Promise<{ topicsDisabled: number }> {
  const cfg = searchlightEnv();
  const plans = planCollectionShutdown(
    await session.getJson(`/companies/${cfg.SEARCHLIGHT_COMPANY_ID}/topics`),
  );
  for (const plan of plans) {
    await session.putJson(`/companies/${cfg.SEARCHLIGHT_COMPANY_ID}/topics/${plan.topicId}`, {
      collectionConfig: plan.collectionConfig,
    });
  }
  return { topicsDisabled: plans.length };
}
