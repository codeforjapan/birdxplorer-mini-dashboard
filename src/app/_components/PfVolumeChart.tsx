"use client";

import { useState } from "react";
import { hhmm } from "@/lib/time";
import type { CrossChartBin } from "@/lib/view";

/**
 * 非Xの「投稿量の時系列」を X 風に見せる単系列バーチャート。
 * X の Chart（クラスタ積み上げ）とは用途が違うため流用せず、単純な単系列として新規に書く。
 * 共通軸の bins を受け取り、本震(赤の破線)・整数Y・時刻ラベル・クリック選択・ホバーツールチップを描く。
 * preserveAspectRatio="none" で親幅に追従するため、線は vector-effect=non-scaling-stroke で太さを一定に保つ。
 */
const W = 960;
const H = 150;
const PAD_LEFT = 30;
const PAD_RIGHT = 8;
const PAD_TOP = 16;
const PAD_BOTTOM = 20;

/** 整数のみのY軸目盛り（X の Chart と同じ考え方）。 */
function niceIntTicks(max: number, targetCount: number): number[] {
  if (max <= 0) return [0, 1];
  const rawStep = max / targetCount;
  const magnitude = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const residual = rawStep / magnitude;
  let step: number;
  if (residual > 5) step = 10 * magnitude;
  else if (residual > 2) step = 5 * magnitude;
  else if (residual > 1) step = 2 * magnitude;
  else step = magnitude;
  step = Math.max(1, Math.round(step));
  const top = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let v = 0; v <= top; v += step) ticks.push(v);
  return ticks;
}

export function PfVolumeChart({
  bins,
  mainshockAt,
  selectedBinStartAt,
  onSelectBin,
}: {
  bins: CrossChartBin[];
  mainshockAt: number;
  selectedBinStartAt: number | null;
  onSelectBin: (startAt: number) => void;
}) {
  // ホバー中のビン index。フックは早期 return より前に呼ぶ（Rules of Hooks）。
  const [hovered, setHovered] = useState<number | null>(null);

  if (bins.length === 0) {
    return <p className="mt-1 text-[11px] text-label">投稿時刻のデータがありません。</p>;
  }
  const plotW = W - PAD_LEFT - PAD_RIGHT;
  const plotH = H - PAD_TOP - PAD_BOTTOM;
  const slot = plotW / bins.length;
  const barWidth = Math.max(1, slot * 0.7);
  const binMs = bins.length > 1 ? bins[1].startAt - bins[0].startAt : 30 * 60 * 1000;

  const maxCount = Math.max(1, ...bins.map((b) => b.count));
  const yTicks = niceIntTicks(maxCount, 3);
  const yMax = yTicks[yTicks.length - 1] || 1;
  const scaleY = (v: number) => PAD_TOP + plotH - (v / yMax) * plotH;
  const xLeft = (i: number) => PAD_LEFT + slot * i + (slot - barWidth) / 2;

  // 本震が軸範囲内にあるときだけ破線を引く。
  const axisStart = bins[0].startAt;
  const axisEnd = bins[bins.length - 1].startAt + binMs;
  const mainshockX =
    mainshockAt >= axisStart && mainshockAt < axisEnd
      ? PAD_LEFT + ((mainshockAt - axisStart) / (axisEnd - axisStart)) * plotW
      : null;

  // 時刻ラベルは4ビンおきに間引く。
  const labelEvery = 4;

  // ホバー中のビン（0件は下でツールチップを出さない）。
  const hoveredBin = hovered !== null ? bins[hovered] : null;

  return (
    <div className="relative w-full" style={{ height: H }}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="block h-full w-full"
        role="img"
        aria-label="投稿量の時系列バーグラフ"
      >
        {/* 水平グリッド＋Yラベル（整数） */}
        {yTicks
          .filter((t) => t > 0)
          .map((t) => (
            <line
              key={`g${t}`}
              x1={PAD_LEFT}
              x2={W - PAD_RIGHT}
              y1={scaleY(t)}
              y2={scaleY(t)}
              stroke="var(--color-grid)"
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
          ))}
        {yTicks.map((t) => (
          <text
            key={`yl${t}`}
            x={PAD_LEFT - 5}
            y={scaleY(t)}
            textAnchor="end"
            dominantBaseline="middle"
            fontSize={9}
            fill="var(--color-label)"
          >
            {t}
          </text>
        ))}

        {/* ホバー中ビンの背景（黒4%。白背景では白の重ね塗りが見えないため黒にする） */}
        {hovered !== null && (
          <rect x={PAD_LEFT + slot * hovered} y={PAD_TOP} width={slot} height={plotH} fill="#000000" opacity={0.04} />
        )}

        {/* 本震の破線（赤はここだけ許可） */}
        {mainshockX !== null && (
          <>
            <line
              x1={mainshockX}
              x2={mainshockX}
              y1={PAD_TOP}
              y2={PAD_TOP + plotH}
              stroke="var(--color-accent)"
              strokeWidth={1}
              strokeDasharray="3 2"
              vectorEffect="non-scaling-stroke"
            />
            <text x={mainshockX + 3} y={PAD_TOP + 8} fontSize={8.5} fill="var(--color-accent)">
              本震 {hhmm(mainshockAt)}
            </text>
          </>
        )}

        {/* バー（単系列・中立色。選択中はインク枠で強調） */}
        {bins.map((b, i) => {
          const h = (b.count / yMax) * plotH;
          const y = PAD_TOP + plotH - h;
          const selected = selectedBinStartAt === b.startAt;
          const interactive = b.count > 0; // 0件のビンはクリック/ホバーの対象にしない（絞り込んでも空・ツールチップも出さない）
          return (
            <g
              key={b.startAt}
              onClick={interactive ? () => onSelectBin(b.startAt) : undefined}
              onMouseEnter={interactive ? () => setHovered(i) : undefined}
              onMouseLeave={interactive ? () => setHovered(null) : undefined}
              style={{ cursor: interactive ? "pointer" : "default" }}
            >
              {/* クリック/ホバー領域（透明・スロット全幅。0件バーには付けない） */}
              {interactive && (
                <rect x={PAD_LEFT + slot * i} y={PAD_TOP} width={slot} height={plotH} fill="transparent" />
              )}
              {h > 0 && <rect x={xLeft(i)} y={y} width={barWidth} height={h} fill="var(--color-bar)" rx={1} />}
              {selected && (
                <rect
                  x={PAD_LEFT + slot * i + 0.5}
                  y={PAD_TOP + 0.5}
                  width={Math.max(0, slot - 1)}
                  height={plotH - 1}
                  fill="none"
                  stroke="var(--color-strong)"
                  strokeOpacity={0.5}
                  strokeWidth={1}
                  vectorEffect="non-scaling-stroke"
                />
              )}
            </g>
          );
        })}

        {/* X軸線＋時刻ラベル */}
        <line
          x1={PAD_LEFT}
          x2={W - PAD_RIGHT}
          y1={PAD_TOP + plotH}
          y2={PAD_TOP + plotH}
          stroke="var(--color-line)"
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
        />
        {bins.map((b, i) =>
          i % labelEvery === 0 ? (
            <text
              key={`xl${b.startAt}`}
              x={PAD_LEFT + slot * i + slot / 2}
              y={H - 6}
              textAnchor="middle"
              fontSize={9}
              fill="var(--color-label)"
            >
              {hhmm(b.startAt)}
            </text>
          ) : null,
        )}
      </svg>

      {/* ツールチップ。ホバー中ビンの上に HTML で重ねる（SVGは preserveAspectRatio=none で歪むため文字はHTML側）。
          位置は SVG 座標→親要素の % に換算（幅は親追従・高さは H 固定なので線形対応）。 */}
      {hoveredBin && hoveredBin.count > 0 && (
        <div
          className="tabular pointer-events-none absolute z-10 whitespace-nowrap rounded-lg border border-line bg-card px-2.5 py-1.5 text-[11px] shadow-none"
          style={{
            left: `${((PAD_LEFT + slot * (hovered ?? 0) + slot / 2) / W) * 100}%`,
            top: `${(scaleY(hoveredBin.count) / H) * 100}%`,
            transform: "translate(-50%, calc(-100% - 6px))",
          }}
        >
          <div className="text-heading">
            {hhmm(hoveredBin.startAt)}〜{hhmm(hoveredBin.startAt + binMs)}
          </div>
          <div className="text-weak">投稿 {hoveredBin.count}件</div>
        </div>
      )}
    </div>
  );
}
