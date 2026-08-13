"use client";

import { useMemo, useState } from "react";
import { mmddhhmm } from "@/lib/time";
import type { CrossPost, CrossPlatform } from "@/lib/types";
import { CROSS_PF_ORDER, buildCrossPlatformSummary, type PfSummary } from "@/lib/view";
import { Sparkline } from "./Sparkline";

/**
 * 非X（YouTube/TikTok/Threads/Web）の Searchlight 分析を「PFサマリーカード（＝絞り込みタブ）＋
 * PFごとの投稿一覧」の2段構えで見せる（design 2026-08-13）。カードで俯瞰し、押すとそのPFの実物を下に絞り込む。
 * 表示は列挙値・要約・URL・数値指標のみ（本文・著者は非保存・非表示）。
 * 配色はバッジ規約準拠（中立背景＋色ドット・赤は本震専用のため使わない）。
 */
const PLATFORM_LABEL: Record<CrossPlatform, string> = {
  youtube: "YouTube",
  tiktok: "TikTok",
  threads: "Threads",
  web: "Web",
};

// PFの識別アイコン。ブランド色は §2.3（赤は本震専用）と衝突するため使わず、単色（currentColor）のグリフで示す。
const PLATFORM_ICON: Record<CrossPlatform, React.ReactNode> = {
  youtube: (
    <svg viewBox="0 0 24 24" aria-hidden className="size-3.5 shrink-0" fill="currentColor">
      <path d="M23 12s0-3.2-.4-4.7a2.5 2.5 0 0 0-1.8-1.8C19.3 5 12 5 12 5s-7.3 0-8.8.4a2.5 2.5 0 0 0-1.8 1.8C1 8.8 1 12 1 12s0 3.2.4 4.7a2.5 2.5 0 0 0 1.8 1.8C4.7 19 12 19 12 19s7.3 0 8.8-.4a2.5 2.5 0 0 0 1.8-1.8C23 15.2 23 12 23 12ZM9.8 15V9l5.2 3-5.2 3Z" />
    </svg>
  ),
  tiktok: (
    <svg viewBox="0 0 24 24" aria-hidden className="size-3.5 shrink-0" fill="currentColor">
      <path d="M16.5 3c.3 2.3 1.6 3.7 3.8 3.9v2.6c-1.3.1-2.5-.3-3.8-1v5.9c0 4-3.2 6.4-6.6 5.3-3-1-4-4.9-1.8-7.3 1-1.1 2.5-1.6 4-1.4v2.7c-.5-.1-1-.1-1.5.1-1 .4-1.5 1.4-1.2 2.4.3 1.1 1.6 1.7 2.7 1.2.8-.4 1.2-1.1 1.2-2V3h3Z" />
    </svg>
  ),
  threads: (
    <svg viewBox="0 0 24 24" aria-hidden className="size-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.7">
      <path d="M12 21c-5 0-8-3.4-8-9s3-9 8-9c3.5 0 5.8 1.7 6.9 4.3M12 21c4.4 0 6.4-2.6 6.4-4.8 0-2.5-2.2-3.8-4.6-3.8-2 0-3.4 1-3.4 2.5 0 1.4 1.2 2.2 2.6 2.2 2 0 3.3-1.6 3.3-4 0-2.2-1.5-3.8-3.6-3.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  web: (
    <svg viewBox="0 0 24 24" aria-hidden className="size-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.6">
      <circle cx="12" cy="12" r="8.5" />
      <path d="M3.5 12h17M12 3.5c2.4 2.3 3.6 5.3 3.6 8.5S14.4 18.2 12 20.5c-2.4-2.3-3.6-5.3-3.6-8.5S9.6 5.8 12 3.5Z" />
    </svg>
  ),
};

const STANCE_LABEL: Record<NonNullable<CrossPost["stance"]>, { text: string; dot: string } | null> = {
  SPREADING: { text: "拡散源", dot: "var(--color-cluster-7)" },
  DEBUNKING: { text: "打消し", dot: "var(--color-cluster-3)" },
  REPORTING: { text: "報道", dot: "var(--color-cluster-0)" },
  NEUTRAL: null,
};

// 立場の内訳バー用（順序＝拡散源→打消し→報道→中立）。色は STANCE_LABEL と揃える。
const STANCE_BAR: { key: keyof PfSummary["stance"]; text: string; color: string }[] = [
  { key: "spreading", text: "拡散源", color: "var(--color-cluster-7)" },
  { key: "debunking", text: "打消し", color: "var(--color-cluster-3)" },
  { key: "reporting", text: "報道", color: "var(--color-cluster-0)" },
  { key: "neutral", text: "中立", color: "var(--color-cluster-other)" },
];

const ALL_LIMIT = 3; // すべて表示時に各PFで見せる件数
const FILTER_STEP = 30; // 絞り込み時の初期件数＝もっと見るの1回分

/** 大きな数は 1.2万 のように畳む（等幅で桁を揃える）。 */
function fmtCount(n: number): string {
  if (n >= 10000) return `${(n / 10000).toFixed(1)}万`;
  return n.toLocaleString("en-US");
}

/** 炎上レートは生値0〜1。小さい値が多いので1%未満は小数2桁で見せる。 */
function fmtFlame(r: number): string {
  const pct = r * 100;
  return `${pct < 1 ? pct.toFixed(2) : pct.toFixed(1)}%`;
}

function Badges({ p }: { p: CrossPost }) {
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
  if (p.urgency === "HIGH" || p.urgency === "MEDIUM") {
    items.push(
      <span key="urg" className="tabular shrink-0 rounded bg-block px-1.5 py-0.5 text-[10px] text-weak">
        {`緊急度: ${p.urgency === "HIGH" ? "高" : "中"}`}
      </span>,
    );
  }
  const isConflict = /conflict/i.test(p.officialRelationship);
  const isInsufficient = /insufficient/i.test(p.officialRelationship);
  if ((isConflict || isInsufficient) && p.officialUrl) {
    items.push(
      <a
        key="off"
        href={p.officialUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="tabular shrink-0 rounded bg-block px-1.5 py-0.5 text-[10px] text-label underline hover:text-body"
      >
        {isConflict ? "公式と相違" : "公式情報"}
      </a>,
    );
  }
  return <>{items}</>;
}

/** 数値指標のフッター。取得できたものだけ「ラベル 値」の並びで出す（無いPFでは何も出さない）。 */
function Metrics({ p }: { p: CrossPost }) {
  const parts: { key: string; label: string; value: string }[] = [];
  if (typeof p.views === "number") parts.push({ key: "views", label: "表示", value: fmtCount(p.views) });
  if (typeof p.likes === "number") parts.push({ key: "likes", label: "いいね", value: fmtCount(p.likes) });
  if (typeof p.comments === "number") parts.push({ key: "comments", label: "コメント", value: fmtCount(p.comments) });
  if (typeof p.shares === "number") parts.push({ key: "shares", label: "シェア", value: fmtCount(p.shares) });
  if (typeof p.collects === "number") parts.push({ key: "collects", label: "保存", value: fmtCount(p.collects) });
  if (typeof p.flameRate === "number") parts.push({ key: "flame", label: "炎上", value: fmtFlame(p.flameRate) });
  if (parts.length === 0) return null;
  return (
    <span className="tabular flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-label">
      {parts.map((m) => (
        <span key={m.key} className="shrink-0">
          {m.label} <span className="text-weak">{m.value}</span>
        </span>
      ))}
    </span>
  );
}

/** 1投稿の行。 */
function PostRow({ p }: { p: CrossPost }) {
  return (
    <li className="flex flex-col gap-1.5 border-b border-line py-3 last:border-b-0">
      <div className="flex flex-wrap items-center gap-1.5">
        <Badges p={p} />
      </div>
      <p className="text-[13px] leading-[1.7] text-body">{p.claimSummary}</p>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <Metrics p={p} />
        <span className="flex shrink-0 items-center gap-2">
          {p.publishedAt !== null && <span className="tabular text-[10px] text-label">{mmddhhmm(p.publishedAt)}</span>}
          <a
            href={p.url}
            target="_blank"
            rel="noopener noreferrer"
            className="shrink-0 text-[11px] text-label underline hover:text-body"
          >
            元投稿を開く
          </a>
        </span>
      </div>
    </li>
  );
}

/** 規模（最大表示/最大いいね/指標なし）を短い文言に整形する。 */
function scaleText(s: PfSummary["scale"]): string {
  if (s.kind === "views" && s.max !== null) return `最大表示 ${fmtCount(s.max)}`;
  if (s.kind === "likes" && s.max !== null) return `最大いいね ${fmtCount(s.max)}`;
  return "指標なし";
}

/** PFサマリーカード（＝絞り込みタブ）。 */
function PfCard({
  s,
  selected,
  onSelect,
}: {
  s: PfSummary;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      id={`crossplatform-tab-${s.platform}`}
      role="tab"
      aria-selected={selected}
      aria-controls="crossplatform-feed"
      onClick={onSelect}
      className={`rounded-xl border border-line bg-card p-3 text-left transition hover:border-muted ${
        selected ? "ring-2 ring-heading" : ""
      }`}
    >
      <div className="flex items-baseline gap-2">
        <span className="flex items-center gap-1.5 text-[13px] font-semibold text-heading">
          {PLATFORM_ICON[s.platform]}
          {PLATFORM_LABEL[s.platform]}
        </span>
        <span className="tabular text-[18px] font-bold text-heading">{s.count}</span>
        <span className="text-[10px] text-muted">件</span>
        {s.latestAt !== null && (
          <span className="tabular ml-auto text-[10px] text-label">最新 {mmddhhmm(s.latestAt)}</span>
        )}
      </div>

      <div className="mt-2">
        <div className="mb-1 text-[10px] text-label">投稿量の推移</div>
        <Sparkline values={s.spark} className="block h-[30px] w-full" />
      </div>

      <div className="mt-2">
        <div className="flex h-2 overflow-hidden rounded bg-block">
          {STANCE_BAR.map((seg) =>
            s.stance[seg.key] > 0 ? (
              <span
                key={seg.key}
                style={{ width: `${(s.stance[seg.key] / s.count) * 100}%`, backgroundColor: seg.color }}
              />
            ) : null,
          )}
        </div>
        <div className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5 text-[10px] text-weak">
          {STANCE_BAR.map((seg) =>
            s.stance[seg.key] > 0 ? (
              <span key={seg.key}>
                <span aria-hidden className="mr-1 inline-block size-1.5 rounded-sm align-middle" style={{ backgroundColor: seg.color }} />
                {seg.text}
                {s.stance[seg.key]}
              </span>
            ) : null,
          )}
        </div>
      </div>

      <div className="mt-2 text-[11px] text-weak">
        緊急度高 <b className="font-bold text-heading">{s.highUrgency}</b> ・ 公式と相違{" "}
        <b className="font-bold text-heading">{s.officialConflict}</b> ・ {scaleText(s.scale)}
      </div>

      {s.topClaim && (
        <div className="mt-1 text-[10px] text-muted">
          最多の種別：<span className="text-weak">{s.topClaim.label}</span>（{s.topClaim.count}件）
        </div>
      )}
    </button>
  );
}

/** PFごとの見出し付きグループ（下段の一覧）。 */
function PfGroup({ label, count, posts }: { label: React.ReactNode; count: number; posts: CrossPost[] }) {
  const hidden = count - posts.length;
  return (
    <div className="mt-4">
      <div className="flex items-center gap-2 border-b-2 border-line pb-1.5 text-[13px] font-semibold text-heading">
        {label}
        <span className="ml-auto text-[11px] font-normal text-label">{count}件</span>
      </div>
      <ul className="flex flex-col">
        {posts.map((p) => (
          <PostRow key={p.insightId} p={p} />
        ))}
      </ul>
      {hidden > 0 && <p className="mt-2 text-[10px] text-label">…ほか {hidden} 件</p>}
    </div>
  );
}

function pfHeadLabel(platform: CrossPlatform): React.ReactNode {
  return (
    <span className="flex items-center gap-1.5">
      {PLATFORM_ICON[platform]}
      {PLATFORM_LABEL[platform]}
    </span>
  );
}

export function CrossPlatformSection({ posts }: { posts: CrossPost[] }) {
  const [selected, setSelected] = useState<CrossPlatform | null>(null);
  const [visible, setVisible] = useState(FILTER_STEP);

  const summary = useMemo(() => buildCrossPlatformSummary(posts), [posts]);
  const byPlatform = useMemo(() => {
    const map = new Map<CrossPlatform, CrossPost[]>();
    for (const p of posts) {
      const arr = map.get(p.platform);
      if (arr) arr.push(p);
      else map.set(p.platform, [p]);
    }
    return map;
  }, [posts]);

  if (posts.length === 0) return null;

  const pick = (platform: CrossPlatform) => {
    setSelected((cur) => (cur === platform ? null : platform));
    setVisible(FILTER_STEP);
  };
  const reset = () => {
    setSelected(null);
    setVisible(FILTER_STEP);
  };

  const selectedPosts = selected ? byPlatform.get(selected) ?? [] : [];

  return (
    <section className="rounded-xl border border-line bg-card p-4 sm:p-5">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-[14px] font-semibold text-heading">他プラットフォームのデマ（X以外）</h2>
        <span className="tabular shrink-0 text-[11px] text-label">{posts.length}件</span>
      </div>
      <p className="mt-1 text-[11px] text-label">
        YouTube・TikTok・Threads・Web で観測された投稿の AI 分析（コミュニティノート非対象）。
      </p>

      {/* 上段A: PFサマリーカード（＝絞り込みタブ）2×2 */}
      <div role="tablist" aria-label="プラットフォーム" className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
        {summary.map((s) => (
          <PfCard key={s.platform} s={s} selected={selected === s.platform} onSelect={() => pick(s.platform)} />
        ))}
      </div>

      {/* フィルタ状態バー */}
      <div className="mt-4 flex items-center gap-2 border-t border-line pt-3">
        <span className="text-[12px] font-semibold text-heading">
          {selected ? `${PLATFORM_LABEL[selected]} に絞り込み中` : "すべてのプラットフォーム"}
        </span>
        <span className="text-[11px] text-label">{selected ? `${selectedPosts.length}件` : `${posts.length}件`}</span>
        {selected && (
          <button
            type="button"
            onClick={reset}
            className="ml-auto rounded-full border border-line bg-block px-3 py-0.5 text-[11px] text-label hover:text-body"
          >
            すべて表示
          </button>
        )}
      </div>

      {/* 下段B: PFごとの投稿一覧（上段のカード＝タブに対応する tabpanel） */}
      <div
        id="crossplatform-feed"
        role="tabpanel"
        aria-labelledby={selected ? `crossplatform-tab-${selected}` : undefined}
      >
        {selected ? (
          <>
            <PfGroup label={pfHeadLabel(selected)} count={selectedPosts.length} posts={selectedPosts.slice(0, visible)} />
            {selectedPosts.length > visible && (
              <button
                type="button"
                onClick={() => setVisible((v) => v + FILTER_STEP)}
                className="mt-3 rounded-full border border-line bg-block px-3 py-1 text-[11px] text-label hover:text-body"
              >
                もっと見る（残り {selectedPosts.length - visible} 件）
              </button>
            )}
          </>
        ) : (
          CROSS_PF_ORDER.filter((pf) => byPlatform.has(pf)).map((pf) => {
            const all = byPlatform.get(pf) ?? [];
            return <PfGroup key={pf} label={pfHeadLabel(pf)} count={all.length} posts={all.slice(0, ALL_LIMIT)} />;
          })
        )}
      </div>
    </section>
  );
}
