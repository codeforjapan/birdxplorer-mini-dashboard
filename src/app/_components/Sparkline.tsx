// 投稿量の時間推移を示す極小の折れ線（Xのタイムライン相当の簡易版）。
// 値は buildCrossPlatformSummary の spark（ビン別件数）。絶対量ではなく形（盛り上がり方）を見せるため、
// 各PF内の最大値で正規化する。軸ラベル・ホバー等は持たない。
const VIEW_W = 100;
const VIEW_H = 32;

export function Sparkline({ values, className }: { values: number[]; className?: string }) {
  const max = values.length > 0 ? Math.max(...values) : 0;
  if (values.length < 2 || max === 0) return null;
  const step = VIEW_W / (values.length - 1);
  const points = values
    .map((v, i) => {
      const x = i * step;
      // 上に伸びるほど件数が多い。上下に2pxの余白を残す。
      const y = VIEW_H - 2 - (v / max) * (VIEW_H - 4);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg
      viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
      preserveAspectRatio="none"
      aria-hidden
      className={className}
    >
      <polyline points={points} fill="none" stroke="var(--color-weak)" strokeWidth={1.4} />
    </svg>
  );
}
