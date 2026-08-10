import type { SearchlightBadge } from "@/lib/types";

/**
 * Searchlight の付加バッジ。マッチしたノートにだけ小さなチップを出す。
 * 表示するのは列挙値と公式URLのみ。post 本文・AI 自由文は扱わない(非永続ルール)。
 *
 * バッジ配色は design.md §2.3・§3「色の使い方」に準拠する。アクセント赤
 * `--color-accent` (#E0143C) は本震線・ヘッダー稼働ドット専用のため警告色として
 * 流用しない。バッジは背景を中立(`bg-block`)にし、文字色は本文インク`text-body`
 * 固定、stance の色identityは先頭の6px丸ドットで担う(色を情報の唯一の担い手に
 * しないよう、ラベル文字を必ず併記する)。
 */
const STANCE_LABEL: Record<SearchlightBadge["stance"], { text: string; dotColor: string } | null> = {
  SPREADING: { text: "拡散源", dotColor: "var(--color-cluster-7)" }, // red
  DEBUNKING: { text: "打消し", dotColor: "var(--color-cluster-3)" }, // yellow
  REPORTING: { text: "報道", dotColor: "var(--color-cluster-0)" }, // blue
  NEUTRAL: null, // 中立は出さない
};

function chip(text: string, cls: string, key: string) {
  return (
    <span key={key} className={`tabular shrink-0 rounded px-1.5 py-0.5 text-[10px] ${cls}`}>
      {text}
    </span>
  );
}

function stanceChip(text: string, dotColor: string, key: string) {
  return (
    <span
      key={key}
      className="tabular flex shrink-0 items-center gap-1 rounded bg-block px-1.5 py-0.5 text-[10px] text-body"
    >
      <span aria-hidden className="inline-block size-1.5 shrink-0 rounded-full" style={{ backgroundColor: dotColor }} />
      {text}
    </span>
  );
}

export function SearchlightBadges({ badge }: { badge: SearchlightBadge }) {
  const chips: React.ReactNode[] = [];
  const stance = STANCE_LABEL[badge.stance];
  if (stance) chips.push(stanceChip(stance.text, stance.dotColor, "stance"));
  if (badge.urgency === "HIGH" || badge.urgency === "MEDIUM") {
    chips.push(chip(`緊急度: ${badge.urgency === "HIGH" ? "高" : "中"}`, "bg-block text-weak", "urgency"));
  }
  // 公式と相違を示すときだけ「公式と相違」チップ。URL があればリンクにする。
  if (/CONFLICT/i.test(badge.officialRelationship)) {
    const label = "公式と相違";
    chips.push(
      badge.officialUrl ? (
        <a
          key="official"
          href={badge.officialUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="tabular shrink-0 rounded bg-block px-1.5 py-0.5 text-[10px] text-label underline hover:text-body"
        >
          {label}
        </a>
      ) : (
        chip(label, "bg-block text-weak", "official")
      ),
    );
  }
  if (chips.length === 0) return null;
  return <span className="flex flex-wrap items-center gap-1">{chips}</span>;
}
