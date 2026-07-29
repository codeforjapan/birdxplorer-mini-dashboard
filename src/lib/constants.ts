/**
 * 単一イベントモニタとしての固定値。
 * 仕様書・デザイン仕様書で確定した値をここに集約する。
 */

/** 本震: 2026-07-28 16:27 JST (M7.1) */
export const MAINSHOCK_AT = Date.parse("2026-07-28T16:27:00+09:00");
export const MAINSHOCK_MAGNITUDE = "M7.1";

/** タイムラインのビン幅（分）。Blob の timeline.json と UI で共有する。 */
export const BIN_MINUTES = 30;

/**
 * クラスタパレット。colorIndex（0-7）に紐づく。
 * クラスタ名ではなく添字に紐づけるのは、クラスタがLLMによって動的に生成されるため。
 *
 * 8色なのは表示スペースの都合ではなく、データビジュアライゼーションの色覚多様性の
 * 原則上、白背景での隣接色対比較（CVD協色: 最悪ペアで protan ΔE 9.1、通常視で ΔE 19.6）
 * を保ったまま安全に見分けられる categorical hue の上限が8だから。9色目以降を無理に
 * 追加する（あるいは巡回させて重複させる）とこの安全マージンが壊れるため、
 * 9位以下は個別色を割り当てず「その他」に畳む(このファイル内 OTHER_CLUSTER_COLOR)。
 *
 * このうち aqua・yellow・magenta は白背景でのコントラスト比が3:1を下回る
 * (design.md §2.1 に実測値を記載)。そのため色を唯一の識別手段にしてはならず、
 * 凡例チップとバッジには必ずクラスタ名をテキストで併記する「relief」が必須(§10)。
 * これは緩和不可の要件であり、実装を変更しても外してはならない。
 */
export const CLUSTER_PALETTE = [
  "#2a78d6", // blue
  "#eb6834", // orange
  "#1baf7a", // aqua (白背景コントラスト2.82:1、要relief)
  "#eda100", // yellow (白背景コントラスト2.17:1、要relief)
  "#e87ba4", // magenta (白背景コントラスト2.69:1、要relief)
  "#008300", // green
  "#4a3aa7", // violet
  "#e34948", // red
] as const;

/** 9位以下のクラスタを集約する「その他」の色。 */
export const OTHER_CLUSTER_COLOR = "#94A3B8";

/**
 * グラフ上で個別の色を与えるクラスタ数の上限。これを超えた分は「その他」に集約する。
 * CLUSTER_PALETTE の長さ(8)と一致させる。値そのものより「なぜ8か」は
 * CLUSTER_PALETTE のコメントを参照。
 */
export const MAX_DISTINCT_CLUSTERS = 8;

/** 「その他」集約に使う擬似クラスタID。実際のクラスタIDと衝突しないようにする。 */
export const OTHER_CLUSTER_ID = "__other__";

/**
 * 本震マーカー・稼働インジケータのみに使うアクセント色。
 * 旧値 #FF3B5C は白背景で3.48:1しかなく、10pxの「本震 16:27」ラベルには不足していた。
 * この値(4.84:1)に置き換えている。警告色として他へ流用しない。
 */
export const ACCENT = "#E0143C";

/**
 * mod を取るため、パレット長が10→8に変わっても既存クラスタの colorIndex は壊れない。
 * 旧パレット時代に採番された colorIndex 8/9 を持つ永続データは、8%8=0(blue)・9%8=1(orange)
 * のように既存の8色のどれかに再マップされる(クラッシュせず、必ず配列内に収まる)。
 * 同じ色を2つの実クラスタが名乗る可能性はあるが、凡例・バッジは名前を必ず併記する(§10)
 * ため識別自体は失われない。
 */
export function clusterColor(colorIndex: number): string {
  const i = ((colorIndex % CLUSTER_PALETTE.length) + CLUSTER_PALETTE.length) % CLUSTER_PALETTE.length;
  return CLUSTER_PALETTE[i];
}

/** バッジ背景用。同色の 13%（16進 `22` サフィックス）。 */
export function clusterTint(colorIndex: number): string {
  return `${clusterColor(colorIndex)}22`;
}
