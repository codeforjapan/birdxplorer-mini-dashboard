import type { CrossPost, CrossPlatform } from "@/lib/types";

/**
 * 非X（YouTube/TikTok/Threads/Web）の Searchlight 分析を独立セクションで一覧表示する。
 * コミュニティノートに紐づかないため per-note バッジには載せられない投稿を、ここで見せる。
 * 表示は列挙値・AI要約・URL のみ（非永続ルール）。配色は design.md のバッジ規約（中立背景＋色ドット）に準拠。
 */
const PLATFORM_LABEL: Record<CrossPlatform, string> = {
  youtube: "YouTube",
  tiktok: "TikTok",
  threads: "Threads",
  web: "Web",
};
const PLATFORM_ORDER: CrossPlatform[] = ["youtube", "tiktok", "threads", "web"];

const STANCE_LABEL: Record<NonNullable<CrossPost["stance"]>, { text: string; dot: string } | null> = {
  SPREADING: { text: "拡散源", dot: "var(--color-cluster-7)" },
  DEBUNKING: { text: "打消し", dot: "var(--color-cluster-3)" },
  REPORTING: { text: "報道", dot: "var(--color-cluster-0)" },
  NEUTRAL: null,
};

function chip(text: string, key: string) {
  return (
    <span key={key} className="tabular shrink-0 rounded bg-block px-1.5 py-0.5 text-[10px] text-weak">
      {text}
    </span>
  );
}

function badges(p: CrossPost) {
  const items: React.ReactNode[] = [];
  const s = p.stance ? STANCE_LABEL[p.stance] : null;
  if (s) {
    items.push(
      <span
        key="stance"
        className="tabular flex shrink-0 items-center gap-1 rounded bg-block px-1.5 py-0.5 text-[10px] text-body"
      >
        <span aria-hidden className="inline-block size-1.5 shrink-0 rounded-full" style={{ backgroundColor: s.dot }} />
        {s.text}
      </span>,
    );
  }
  if (p.urgency === "HIGH" || p.urgency === "MEDIUM") items.push(chip(`緊急度: ${p.urgency === "HIGH" ? "高" : "中"}`, "urg"));
  if (/conflict/i.test(p.officialRelationship) && p.officialUrl) {
    items.push(
      <a
        key="off"
        href={p.officialUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="tabular shrink-0 rounded bg-block px-1.5 py-0.5 text-[10px] text-label underline hover:text-body"
      >
        公式と相違
      </a>,
    );
  } else if (/insufficient/i.test(p.officialRelationship) && p.officialUrl) {
    items.push(
      <a
        key="off"
        href={p.officialUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="tabular shrink-0 rounded bg-block px-1.5 py-0.5 text-[10px] text-label underline hover:text-body"
      >
        公式情報
      </a>,
    );
  }
  return items;
}

export function CrossPlatformSection({ posts }: { posts: CrossPost[] }) {
  if (posts.length === 0) return null;
  const groups = PLATFORM_ORDER.map((pf) => ({ pf, items: posts.filter((p) => p.platform === pf) })).filter(
    (g) => g.items.length > 0,
  );
  if (groups.length === 0) return null;

  return (
    <section className="rounded-xl border border-line bg-card p-4 sm:p-5">
      <h2 className="text-[14px] font-semibold text-heading">他プラットフォームのデマ（X以外）</h2>
      <p className="mt-1 text-[11px] text-label">
        YouTube・TikTok・Threads・Web で観測された投稿の AI 分析（コミュニティノート非対象）。
      </p>
      <ul className="mt-3 flex flex-col gap-1">
        {groups.map((g) => (
          <li key={g.pf} className="border-b border-line last:border-b-0">
            <details className="group/row">
              <summary
                className="flex cursor-pointer list-none items-center gap-2 rounded-md px-1 py-2 outline-none transition-colors hover:bg-block"
                style={{ transitionDuration: "150ms" }}
              >
                <span className="min-w-0 flex-1 truncate text-[13px] text-body">{PLATFORM_LABEL[g.pf]}</span>
                <span className="tabular shrink-0 text-[11px] text-label">{g.items.length}件</span>
              </summary>
              <ul className="mt-1 mb-3 flex flex-col gap-2 pl-1">
                {g.items.map((p) => (
                  <li key={p.insightId} className="flex flex-col gap-1">
                    <div className="flex flex-wrap items-center gap-1">{badges(p)}</div>
                    <p className="text-[13px] leading-[1.7] text-body">{p.claimSummary}</p>
                    <a
                      href={p.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[11px] text-label underline hover:text-body"
                    >
                      元投稿を開く
                    </a>
                  </li>
                ))}
              </ul>
            </details>
          </li>
        ))}
      </ul>
    </section>
  );
}
