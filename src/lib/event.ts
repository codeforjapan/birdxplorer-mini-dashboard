/**
 * 「今回このモニタが追っているイベント」に固有の値を1箇所に集約する。
 *
 * 別テーマ（別の災害・選挙等）に転用する際は、原則としてこのファイルだけを
 * 書き換えれば済むようにする（他ファイルはこの値を参照するだけで、
 * イベント固有の文言・日付・キーワードを直接持たない）。
 *
 * 例外: src/lib/llm/*.ts の分類・レポート生成プロンプート本文は、
 * ここでの「主語の差し替え」（EVENT.llmContextPhrase 等）だけでは吸収できない
 * テーマ固有の判断基準（何が誤情報か、どんな噂の型があるか等）を含むため、
 * テーマを変える場合は各プロンプトの内容そのものを書き直す必要がある。
 */

export const EVENT = {
  // ── サイトの識別・表示文言 ──────────────────────────────────
  /** <title> と h1 に使う名称。 */
  siteTitle: "コミュニティノートタイムライン 令和8年熊本地震",
  /** <meta description>。 */
  siteDescription:
    "令和8年熊本地震（2026年7月28日 16:27 発生・M7.1）に関するXコミュニティノートを継続収集し、内容ごとに分類して時系列で可視化する観測サイト。",
  /** ヘッダー最上段のラベル。 */
  eyebrowLabel: "BirdXplorer コミュニティノート観測",
  /** ヘッダーの発生日時説明文。 */
  occurredAtLabel: "2026年7月28日 16:27 発生（M7.1）",

  // ── 基準時刻（タイムライン起点・統計カード等で使う） ────────────
  /** epoch ms。 */
  occurredAt: Date.parse("2026-07-28T16:27:00+09:00"),

  // ── 統計カード「本震」枠 ──────────────────────────────────
  keyMomentLabel: "本震",
  keyMomentMagnitude: "M7.1",

  // ── 収集条件 ──────────────────────────────────────────────
  // OR・部分一致でゆるく収集する検索語。地震周辺の言説を取りこぼさないよう拡張しており、
  // 無関係なノートは Stage1 の関連性判定（llm/relevance.ts）で弾く前提。
  searchKeywords: [
    "熊本",
    "地震",
    "津波",
    "災害",
    "避難所",
    "氷川",
    "八代",
    "九州",
    "令和8年",
    "令和８年",
    "イオンモール",
    "トリアージ",
    "震度7",
    "宇城",
    "阿蘇",
    "自衛隊",
    "被災",
    "義援金",
    "募金",
    "ボランティア",
  ] as const,

  // ── LLM プロンプト内で繰り返し使う、イベントを指す主語 ──────────
  /** 例:「あなたは『{llmContextPhrase}』を起点に流通した情報を観測するモニタの分類器です。」 */
  llmContextPhrase: "2026年7月28日に発生した熊本地震",
  /** 短縮形。例:「今回の{llmContextPhraseShort}に関係するか」 */
  llmContextPhraseShort: "熊本地震",

  // ── OpenRouter へのアプリ帰属ヘッダー（ランキング・サポート追跡用） ──
  // 独自ドメインを取得していない運用のため固定文字列で代用する。
  githubRepo: "code4japan/kumamoto-birdxplorer",
  appTitle: "kumamoto-birdxplorer",

  // ── フッター: 訂正窓口・一次情報への導線 ──────────────────────
  /** GitHub Issues。誤分類・レポートの誤り・削除依頼の唯一の受付経路(spec.md §8-8)。 */
  issuesUrl: "https://github.com/codeforjapan/kumamoto-earthquake-dashboard/issues",
  officialSourcesIntro: "地震・被害・避難に関する一次情報は",
  officialSources: [
    { label: "気象庁", url: "https://www.jma.go.jp/" },
    { label: "熊本県", url: "https://www.pref.kumamoto.jp/" },
  ] as const,
  officialSourcesDisclaimer: "本サイトは防災情報を提供するものではありません。",
} as const;
