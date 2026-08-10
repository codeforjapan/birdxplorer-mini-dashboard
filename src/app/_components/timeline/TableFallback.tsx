import { hhmm } from "@/lib/time";
import type { ChartBin, DisplayCluster } from "@/lib/view";

/**
 * グラフの表形式フォールバック(design.md §10)。
 * SVGの積み上げ棒は視覚的な比較には向くが、スクリーンリーダーでは読み上げにくい。
 * 詳細パネルと同等の内容(時間帯ごとのクラスタ別件数)を、視覚的には隠しつつ
 * 支援技術からは読めるテーブルとして常に用意しておく。
 *
 * sr-only は必ず「ラップする div」に付ける。<table> に直接 sr-only を付けると、
 * table レイアウトが width/height:1px を最小値として無視し中身の行数分に伸びるため、
 * 視覚的には clip-path で隠れていてもスクロール高さを数千〜数万px 占有し、
 * フッター下に巨大な余白が生じる(638行で実測 ~15000px)。ブロック要素の div なら
 * width/height:1px + overflow:hidden が効き、中の table はレイアウトから外れる。
 */
export function TableFallback({ bins, legend }: { bins: ChartBin[]; legend: DisplayCluster[] }) {
  return (
    <div className="sr-only">
      <table>
        <caption>30分単位のNote付与件数(表形式)</caption>
        <thead>
          <tr>
            <th scope="col">時間帯</th>
            {legend.map((c) => (
              <th scope="col" key={c.id}>
                {c.name}
              </th>
            ))}
            <th scope="col">合計</th>
          </tr>
        </thead>
        <tbody>
          {bins.map((bin) => (
            <tr key={bin.startAt}>
              <th scope="row">{hhmm(bin.startAt)}</th>
              {legend.map((c) => (
                <td key={c.id}>{bin.segments.find((s) => s.id === c.id)?.count ?? 0}</td>
              ))}
              <td>{bin.total}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
