// claim_type は Searchlight が付与する UPPER_SNAKE の列挙トークン（例 RUMOR_OR_UNVERIFIED）。
// カードの「最多の種別」表示用に日本語へ写像する。未知トークンはそのまま公開面に出さず
// 「その他」へ丸める（自由文を出さない不変条件と整合。src/lib/searchlight.ts の isEnumToken 参照）。
export const CLAIM_TYPE_LABEL: Record<string, string> = {
  RUMOR_OR_UNVERIFIED: "未確認のうわさ",
  RUMOR: "うわさ・未確認情報",
  SCAM: "詐欺・義援金詐欺",
  IMPERSONATION: "なりすまし・偽アカウント",
  FALSE_DAMAGE: "誤った被害情報",
  DAMAGE_REPORT: "被害の報道",
  FALSE_RESCUE: "誤った救助・支援情報",
  DEBUNK: "デマの打消し",
};

/** 既知トークンは日本語ラベル、未知は「その他」。 */
export function claimTypeLabel(token: string): string {
  return CLAIM_TYPE_LABEL[token] ?? "その他";
}
