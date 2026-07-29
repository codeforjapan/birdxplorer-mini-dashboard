"use client";

import { useState } from "react";
import { Chart } from "./Chart";
import { ClusterNoteList } from "./ClusterNoteList";
import { DetailPanel } from "./DetailPanel";
import { Legend } from "./Legend";
import { TableFallback } from "./TableFallback";
import type { ChartBin, DisplayCluster, ViewNote } from "@/lib/view";

/**
 * タイムライングラフ・凡例・詳細パネルをまとめて状態管理するクライアントコンポーネント。
 *
 * データ取得はページ(サーバーコンポーネント)側で完結させ、ここにはプレーンな配列だけを渡す。
 * 「選択中のビン」「強調中のクラスタ」「ホバー中のビン」の3つの状態をここで一元管理し、
 * グラフ・凡例・詳細パネルの間で共有する(どれか1つが子コンポーネント内で状態を持つと、
 * クリックで詳細パネルを連動させる、という要求(§7)を満たせなくなるため)。
 */
export function TimelineExplorer({
  bins,
  legend,
  notes,
  binMinutes,
  mainshockAt,
  initialSelectedIndex,
}: {
  bins: ChartBin[];
  legend: DisplayCluster[];
  notes: ViewNote[];
  binMinutes: number;
  mainshockAt: number;
  initialSelectedIndex: number;
}) {
  const [selectedIndex, setSelectedIndex] = useState(initialSelectedIndex);
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const [highlightedClusterId, setHighlightedClusterId] = useState<string | null>(null);

  const isEmpty = bins.every((b) => b.total === 0);
  const selectedBin = bins[selectedIndex] as ChartBin | undefined;
  const binWidthMs = binMinutes * 60 * 1000;

  const notesForSelectedBin = selectedBin
    ? notes
        .filter((n) => n.createdAt >= selectedBin.startAt && n.createdAt < selectedBin.startAt + binWidthMs)
        .sort((a, b) => a.createdAt - b.createdAt)
    : [];

  return (
    <div className="flex flex-col gap-4">
      <section className="rounded-xl border border-line bg-card p-4 sm:p-5">
        <div className="mb-3 flex items-center justify-between gap-2">
          <h2 className="text-[14px] font-semibold text-heading">30分単位のNote付与件数</h2>
          <span className="shrink-0 text-[10px] text-label">クリックで内訳を表示</span>
        </div>

        <Chart
          bins={bins}
          legend={legend}
          binMinutes={binMinutes}
          mainshockAt={mainshockAt}
          selectedIndex={selectedIndex}
          hoveredIndex={hoveredIndex}
          highlightedClusterId={highlightedClusterId}
          onSelect={setSelectedIndex}
          onHover={setHoveredIndex}
        />

        {isEmpty ? (
          <p className="mt-3 text-[13px] text-label">対象期間に該当するNoteはまだありません。</p>
        ) : (
          <div className="mt-3">
            <Legend
              legend={legend}
              highlightedClusterId={highlightedClusterId}
              onToggle={(id) =>
                setHighlightedClusterId((current) => (current === id ? null : id))
              }
            />
          </div>
        )}

        <TableFallback bins={bins} legend={legend} />
      </section>

      {!isEmpty && selectedBin && (
        <DetailPanel
          binStartAt={selectedBin.startAt}
          binEndAt={selectedBin.startAt + binWidthMs}
          notes={notesForSelectedBin}
        />
      )}

      <ClusterNoteList notes={notes} />
    </div>
  );
}
