"use client";

import { useMemo, useState } from "react";
import { MAINSHOCK_AT } from "@/lib/constants";
import { mmddhhmm } from "@/lib/time";
import type { CrossPost, CrossPlatform } from "@/lib/types";
import {
  buildCrossPlatformSummary,
  filterCrossPosts,
  type CrossFilter,
  type PfSummary,
} from "@/lib/view";
import { PfVolumeChart } from "./PfVolumeChart";

/**
 * 非X（YouTube/TikTok/Threads/Web）の Searchlight 分析を「PFブロック（サマリー＋投稿量チャート）＋
 * 全PF混在の一覧（絞り込み可）」の構成で見せる（design 2026-08-13）。
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

/** 規模（最大表示/最大いいね/指標なし）を短い文言に整形する。 */
function scaleText(s: PfSummary["scale"]): string {
  if (s.kind === "views" && s.max !== null) return `最大表示 ${fmtCount(s.max)}`;
  if (s.kind === "likes" && s.max !== null) return `最大いいね ${fmtCount(s.max)}`;
  return "指標なし";
}

const LIST_STEP = 60; // 混在一覧の初期表示件数＝もっと見るの1回分

/** 混在一覧の1行。PFアイコン＋PF名を先頭に出す（どのPFの投稿か区別するため）。 */
function PostRow({ p }: { p: CrossPost }) {
  return (
    <li className="flex flex-col gap-1.5 border-b border-line py-3 last:border-b-0">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="flex items-center gap-1 text-[11px] text-label">
          <span className="flex text-muted">{PLATFORM_ICON[p.platform]}</span>
          {PLATFORM_LABEL[p.platform]}
        </span>
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

/** PFブロック（サマリー＋投稿量チャート）。見出しクリックで PF 全体、バークリックで PF×時間帯を選択。 */
function PfBlock({
  s,
  filter,
  onPickPlatform,
  onPickBin,
}: {
  s: PfSummary;
  filter: CrossFilter | null;
  onPickPlatform: () => void;
  onPickBin: (startAt: number) => void;
}) {
  const activePlatform = filter?.platform === s.platform;
  const selectedBinStartAt = activePlatform ? filter?.binStartAt ?? null : null;
  return (
    <section
      className={`rounded-xl border bg-card p-4 ${activePlatform ? "border-heading" : "border-line"}`}
    >
      {/* 見出し（クリックで PF 全体に絞り込み） */}
      <button
        type="button"
        aria-pressed={activePlatform && filter?.binStartAt === null}
        onClick={onPickPlatform}
        className="flex w-full items-baseline gap-2 text-left"
      >
        <span className="flex items-center gap-1.5 text-[14px] font-semibold text-heading">
          <span className="flex text-muted">{PLATFORM_ICON[s.platform]}</span>
          {PLATFORM_LABEL[s.platform]}
        </span>
        <span className="tabular text-[18px] font-bold text-heading">{s.count}</span>
        <span className="text-[10px] text-muted">件</span>
        {s.latestAt !== null && (
          <span className="tabular ml-auto text-[10px] text-label">最新 {mmddhhmm(s.latestAt)}</span>
        )}
      </button>

      {/* 立場の内訳バー */}
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
                <span
                  aria-hidden
                  className="mr-1 inline-block size-1.5 rounded-sm align-middle"
                  style={{ backgroundColor: seg.color }}
                />
                {seg.text}
                {s.stance[seg.key]}
              </span>
            ) : null,
          )}
        </div>
      </div>

      {/* 要注意＋規模＋最多種別 */}
      <div className="mt-2 text-[11px] text-weak">
        緊急度高 <b className="font-bold text-heading">{s.highUrgency}</b> ・ 公式と相違{" "}
        <b className="font-bold text-heading">{s.officialConflict}</b> ・ {scaleText(s.scale)}
      </div>
      {s.topClaim && (
        <div className="mt-1 text-[10px] text-muted">
          最多の種別：<span className="text-weak">{s.topClaim.label}</span>（{s.topClaim.count}件）
        </div>
      )}

      {/* 投稿量チャート（クリックで時間帯絞り込み） */}
      <div className="mt-3">
        <div className="mb-1 text-[10px] text-label">投稿量の推移（30分・クリックで絞り込み）</div>
        <PfVolumeChart
          bins={s.chartBins}
          mainshockAt={MAINSHOCK_AT}
          selectedBinStartAt={selectedBinStartAt}
          onSelectBin={onPickBin}
        />
      </div>
    </section>
  );
}

export function CrossPlatformTab({ posts }: { posts: CrossPost[] }) {
  const [filter, setFilter] = useState<CrossFilter | null>(null);
  const [visible, setVisible] = useState(LIST_STEP);

  const summaries = useMemo(() => buildCrossPlatformSummary(posts), [posts]);
  const shown = useMemo(() => filterCrossPosts(posts, filter), [posts, filter]);

  if (posts.length === 0) {
    return (
      <p className="rounded-xl border border-line bg-card p-4 text-[13px] text-label">
        他プラットフォームの観測データはまだありません。
      </p>
    );
  }

  const pickPlatform = (platform: CrossPlatform) => {
    setFilter((cur) => (cur && cur.platform === platform && cur.binStartAt === null ? null : { platform, binStartAt: null }));
    setVisible(LIST_STEP);
  };
  const pickBin = (platform: CrossPlatform, startAt: number) => {
    setFilter((cur) =>
      cur && cur.platform === platform && cur.binStartAt === startAt ? null : { platform, binStartAt: startAt },
    );
    setVisible(LIST_STEP);
  };
  const reset = () => {
    setFilter(null);
    setVisible(LIST_STEP);
  };

  const filterLabel = filter
    ? filter.binStartAt === null
      ? `${PLATFORM_LABEL[filter.platform]} に絞り込み中`
      : `${PLATFORM_LABEL[filter.platform]}・${mmddhhmm(filter.binStartAt)}〜 に絞り込み中`
    : "すべてのプラットフォーム";

  return (
    <div className="flex flex-col gap-4">
      <div>
        <div className="mb-1 flex items-baseline justify-between gap-2">
          <h2 className="text-[14px] font-semibold text-heading">他プラットフォームのデマ（X以外）</h2>
          <span className="tabular shrink-0 text-[11px] text-label">{posts.length}件</span>
        </div>
        <p className="text-[11px] text-label">
          YouTube・TikTok・Threads・Web で観測された投稿の AI 分析（コミュニティノート非対象）。
        </p>
      </div>

      {/* PFブロック × 4（縦積み） */}
      <div className="flex flex-col gap-3">
        {summaries.map((s) => (
          <PfBlock
            key={s.platform}
            s={s}
            filter={filter}
            onPickPlatform={() => pickPlatform(s.platform)}
            onPickBin={(startAt) => pickBin(s.platform, startAt)}
          />
        ))}
      </div>

      {/* フィルタ状態バー */}
      <div className="flex items-center gap-2 border-t border-line pt-3">
        <span className="text-[12px] font-semibold text-heading">{filterLabel}</span>
        <span className="text-[11px] text-label">{shown.length}件</span>
        {filter && (
          <button
            type="button"
            onClick={reset}
            className="ml-auto rounded-full border border-line bg-block px-3 py-0.5 text-[11px] text-label hover:text-body"
          >
            すべて表示
          </button>
        )}
      </div>

      {/* 全PF混在の一覧 */}
      <ul className="flex flex-col">
        {shown.slice(0, visible).map((p) => (
          <PostRow key={p.insightId} p={p} />
        ))}
      </ul>
      {shown.length > visible && (
        <button
          type="button"
          onClick={() => setVisible((v) => v + LIST_STEP)}
          className="self-start rounded-full border border-line bg-block px-3 py-1 text-[11px] text-label hover:text-body"
        >
          もっと見る（残り {shown.length - visible} 件）
        </button>
      )}
    </div>
  );
}
