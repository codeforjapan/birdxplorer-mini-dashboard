"use client";

import { hhmm } from "@/lib/time";
import type { ChartBin, DisplayCluster } from "@/lib/view";

/**
 * タイムライングラフ本体(design.md §6.3)。
 *
 * チャートライブラリを使わず SVG を手書きしている理由は仕様側にある:
 * 水平グリッドのみ・Y軸は軸線非表示・X軸目盛りの間引き(3本/4本おき)・最上段のみ
 * 上端2px角丸・16:30の破線基準線、といった要求はライブラリの既定の描画と噛み合わず、
 * 素のSVGで座標計算した方が結局は速い。`viewBox` を使うことで「常に親幅に追従し、
 * 横スクロールを発生させない」(§8)も自然に満たせる。
 *
 * 内部座標系は幅Wを固定の論理単位とし、CSS側で `width:100%` にすることで実際の
 * 表示幅に追従させる(`preserveAspectRatio="none"` で縦横を独立にスケールさせる)。
 * 高さはCSSで320pxに固定しつつ viewBox の高さも320に揃えているため、縦方向は
 * どの画面幅でも常に等倍で描画される。
 */

const W = 960;
const H = 320;
const PAD_LEFT = 28; // Y軸ラベル用の幅(§6.3)
const PAD_RIGHT = 8;
const PAD_TOP = 28; // 「本震 16:27」ラベルの余白
const PAD_BOTTOM = 22; // X軸目盛りラベル用

/** 整数のみのY軸目盛りを生成する(§6.3: 「Y軸:整数のみ」)。 */
function niceIntTicks(max: number, targetCount: number): number[] {
  if (max <= 0) return [0];
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

/** 上端2辺だけを2px角丸にした矩形のパス(最上段セグメント専用。design.md §6.3)。 */
function roundedTopRectPath(x: number, y: number, w: number, h: number, r: number): string {
  const radius = Math.max(0, Math.min(r, w / 2, h));
  if (radius === 0) return `M${x},${y + h} L${x},${y} L${x + w},${y} L${x + w},${y + h} Z`;
  return [
    `M${x},${y + h}`,
    `L${x},${y + radius}`,
    `Q${x},${y} ${x + radius},${y}`,
    `L${x + w - radius},${y}`,
    `Q${x + w},${y} ${x + w},${y + radius}`,
    `L${x + w},${y + h}`,
    "Z",
  ].join(" ");
}

export type ChartProps = {
  bins: ChartBin[];
  legend: DisplayCluster[];
  binMinutes: number;
  mainshockAt: number;
  selectedIndex: number;
  hoveredIndex: number | null;
  highlightedClusterId: string | null;
  onSelect: (index: number) => void;
  onHover: (index: number | null) => void;
};

export function Chart({
  bins,
  legend,
  binMinutes,
  mainshockAt,
  selectedIndex,
  hoveredIndex,
  highlightedClusterId,
  onSelect,
  onHover,
}: ChartProps) {
  const n = bins.length;
  const plotW = W - PAD_LEFT - PAD_RIGHT;
  const plotH = H - PAD_TOP - PAD_BOTTOM;
  const slot = n > 0 ? plotW / n : plotW;
  const barWidth = Math.max(2, slot * 0.62);

  const maxTotal = Math.max(1, ...bins.map((b) => b.total));
  const yTicks = niceIntTicks(maxTotal, 4);
  const yMax = yTicks[yTicks.length - 1] || 1;
  const scaleY = (v: number) => PAD_TOP + plotH - (v / yMax) * plotH;

  const xCenter = (i: number) => PAD_LEFT + slot * i + slot / 2;
  const xLeft = (i: number) => PAD_LEFT + slot * i + (slot - barWidth) / 2;

  // 間引き間隔は §8 のブレークポイントに正確に合わせるため、Tailwind の sm(640px) を境に
  // 2セットの目盛りラベルを用意し、CSSの表示切り替え(hidden/sm:block)だけで出し分ける。
  const tickEvery3 = bins.map((b, i) => ({ i, bin: b })).filter(({ i }) => i % 3 === 0);
  const tickEvery4 = bins.map((b, i) => ({ i, bin: b })).filter(({ i }) => i % 4 === 0);

  // 本震の基準線: 「16:30」のビンの左端に破線を引く(design.md §6.3)。
  const mainshockBinIndex = bins.findIndex((b) => hhmm(b.startAt) === "16:30");

  const hovered = hoveredIndex !== null ? bins[hoveredIndex] : null;
  const hoveredTop = hovered ? scaleY(hovered.total) : 0;

  return (
    <div className="relative w-full" style={{ height: H }}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="block w-full"
        style={{ height: H }}
        role="img"
        aria-label="30分単位のNote付与件数の積み上げ棒グラフ。詳細は下部の表を参照してください。"
      >
        {/* 水平グリッド線のみ(§6.3: 垂直グリッドは引かない) */}
        {yTicks
          .filter((t) => t > 0)
          .map((t) => (
            <line
              key={t}
              x1={PAD_LEFT}
              x2={W - PAD_RIGHT}
              y1={scaleY(t)}
              y2={scaleY(t)}
              stroke="var(--color-grid)"
              strokeWidth={1}
            />
          ))}

        {/* Y軸ラベル(軸線・目盛り線は非表示。文字だけを左余白に置く) */}
        {yTicks.map((t) => (
          <text
            key={t}
            x={PAD_LEFT - 6}
            y={scaleY(t)}
            textAnchor="end"
            dominantBaseline="middle"
            className="tabular"
            fontSize={10}
            fill="var(--color-label)"
          >
            {t}
          </text>
        ))}

        {/* X軸の軸線 */}
        <line
          x1={PAD_LEFT}
          x2={W - PAD_RIGHT}
          y1={PAD_TOP + plotH}
          y2={PAD_TOP + plotH}
          stroke="var(--color-line)"
          strokeWidth={1}
        />

        {/* ホバー中のビンの背景(黒4%。白背景では白の重ね塗りが不可視になるため黒に変更) */}
        {hoveredIndex !== null && (
          <rect
            x={PAD_LEFT + slot * hoveredIndex}
            y={PAD_TOP}
            width={slot}
            height={plotH}
            fill="#000000"
            opacity={0.04}
          />
        )}

        {/* 選択中のビンを示す枠(コンソールらしく色と線のみ。移動やスケール変化はしない) */}
        {selectedIndex >= 0 && selectedIndex < n && (
          <rect
            x={PAD_LEFT + slot * selectedIndex + 1}
            y={PAD_TOP + 1}
            width={Math.max(0, slot - 2)}
            height={Math.max(0, plotH - 2)}
            fill="none"
            stroke="var(--color-strong)"
            strokeOpacity={0.35}
            strokeWidth={1}
          />
        )}

        {/* 積み上げ棒 */}
        {bins.map((bin, i) => {
          let cumulative = 0;
          const x = xLeft(i);
          return (
            <g key={bin.startAt}>
              {bin.segments.map((seg, segIdx) => {
                const isTop = segIdx === bin.segments.length - 1;
                const y0 = scaleY(cumulative);
                cumulative += seg.count;
                const y1 = scaleY(cumulative);
                const height = Math.max(0, y0 - y1);
                const cluster = legend.find((c) => c.id === seg.id);
                const color = cluster?.color ?? "var(--color-label)";
                const dimmed = highlightedClusterId !== null && highlightedClusterId !== seg.id;
                // 旧値12%は白いcard背景の上ではどのクラスタ色も対白コントラストが
                // 1.1〜1.2:1程度まで落ち、セグメントが実質消えて「グラフ全体としての
                // 読める形」が壊れていた(実測値はdesign.md §3参照)。35%に引き上げ、
                // 選択中(90%)との差ははっきり残しつつ、非選択セグメントも見える状態を保つ。
                const opacity = dimmed ? 0.35 : 0.9;
                return isTop ? (
                  <path
                    key={seg.id}
                    d={roundedTopRectPath(x, y1, barWidth, height, 2)}
                    fill={color}
                    opacity={opacity}
                    style={{ transition: "opacity 150ms" }}
                  />
                ) : (
                  <rect
                    key={seg.id}
                    x={x}
                    y={y1}
                    width={barWidth}
                    height={height}
                    fill={color}
                    opacity={opacity}
                    style={{ transition: "opacity 150ms" }}
                  />
                );
              })}
              {/* キーボード到達・クリック可能なヒットエリア(§10)。バーの見た目とは別に全高で確保する。 */}
              <rect
                x={PAD_LEFT + slot * i}
                y={PAD_TOP}
                width={slot}
                height={plotH}
                fill="transparent"
                tabIndex={0}
                role="button"
                aria-label={`${hhmm(bin.startAt)}からの30分間、合計${bin.total}件${
                  selectedIndex === i ? "(選択中)" : ""
                }`}
                onMouseEnter={() => onHover(i)}
                onMouseLeave={() => onHover(null)}
                onFocus={() => onHover(i)}
                onBlur={() => onHover(null)}
                onClick={() => onSelect(i)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onSelect(i);
                  }
                }}
                style={{ cursor: "pointer" }}
              />
            </g>
          );
        })}

        {/* X軸目盛り(640px以上: 3本おき / 640px未満: 4本おき) */}
        <g className="hidden sm:block">
          {tickEvery3.map(({ i, bin }) => (
            <text
              key={i}
              x={xCenter(i)}
              y={PAD_TOP + plotH + 14}
              textAnchor="middle"
              className="tabular"
              fontSize={10}
              fill="var(--color-label)"
            >
              {hhmm(bin.startAt)}
            </text>
          ))}
        </g>
        <g className="block sm:hidden">
          {tickEvery4.map(({ i, bin }) => (
            <text
              key={i}
              x={xCenter(i)}
              y={PAD_TOP + plotH + 14}
              textAnchor="middle"
              className="tabular"
              fontSize={10}
              fill="var(--color-label)"
            >
              {hhmm(bin.startAt)}
            </text>
          ))}
        </g>

        {/* 本震の基準線 */}
        {mainshockBinIndex >= 0 && (
          <g>
            <line
              x1={PAD_LEFT + slot * mainshockBinIndex}
              x2={PAD_LEFT + slot * mainshockBinIndex}
              y1={PAD_TOP}
              y2={PAD_TOP + plotH}
              stroke="var(--color-accent)"
              strokeWidth={1}
              strokeDasharray="4 3"
            />
            <text
              x={PAD_LEFT + slot * mainshockBinIndex + 4}
              y={PAD_TOP - 6}
              className="tabular"
              fontSize={10}
              fill="var(--color-accent)"
            >
              本震 {hhmm(mainshockAt)}
            </text>
          </g>
        )}
      </svg>

      {/* ツールチップ。合計0のビンでは表示しない(§6.3)。 */}
      {hovered && hovered.total > 0 && (
        <div
          className="tabular pointer-events-none absolute z-10 rounded-lg border border-line bg-card px-3 py-2 text-[12px] shadow-none"
          style={{
            left: `${(xCenter(hoveredIndex ?? 0) / W) * 100}%`,
            top: `${(hoveredTop / H) * 100}%`,
            transform: "translate(-50%, -100%) translateY(-8px)",
            minWidth: 160,
          }}
        >
          <div className="font-semibold text-heading">
            {hhmm(hovered.startAt)}〜 計{hovered.total}件
          </div>
          <div className="mt-1 flex flex-col gap-0.5">
            {hovered.segments.map((seg) => {
              const cluster = legend.find((c) => c.id === seg.id);
              if (!cluster || seg.count === 0) return null;
              return (
                <div key={seg.id} className="flex items-center gap-1.5 text-body">
                  <span
                    aria-hidden
                    className="inline-block size-2 rounded-[2px]"
                    style={{ backgroundColor: cluster.color }}
                  />
                  <span className="truncate">{cluster.name}</span>
                  <span className="ml-auto text-label">{seg.count}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
      <span className="sr-only">ビン幅は{binMinutes}分です。</span>
    </div>
  );
}
