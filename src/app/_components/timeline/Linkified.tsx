import { Fragment } from "react";

/**
 * http(s):// で始まり、URLとして妥当な文字が続く区間にマッチする。
 * 末尾の日本語句読点(。、）等)は文字集合に含めていないため、そこで自然に区切れる。
 */
const URL_PATTERN = /\bhttps?:\/\/[-A-Za-z0-9+&@#/%?=~_|!:,.;]*[-A-Za-z0-9+&@#/%=~_|]/g;

/**
 * note.summary は BirdXplorer API から来るコミュニティノートの生テキストで、
 * Markdownではない(design.md がMarkdownレンダリングを規定するのはレポート本文
 * §6.7のみ)。react-markdown等で全文をパースすると、ノート本文中の `*`・`_`・`#`
 * などが意図しない書式に化けるおそれがあるため使わない。ここではURLの検出とリンク化
 * だけを素朴な正規表現で行う(依存追加なしで済む範囲の要件のため、パースライブラリは
 * 導入しない)。
 *
 * URL文字列自体は空白を含まない1トークンなので、そのままでは折り返せずコンテナ幅を
 * 超えてオーバーフローする。`break-all` で任意の文字位置での折り返しを許可する。
 */
export function Linkified({ text }: { text: string }) {
  const parts = text.split(URL_PATTERN);
  const urls = text.match(URL_PATTERN) ?? [];

  return (
    <>
      {parts.map((part, i) => (
        <Fragment key={i}>
          {part}
          {urls[i] && (
            <a
              href={urls[i]}
              target="_blank"
              rel="noopener noreferrer"
              className="break-all underline decoration-line underline-offset-2 hover:text-strong"
            >
              {urls[i]}
            </a>
          )}
        </Fragment>
      ))}
    </>
  );
}
