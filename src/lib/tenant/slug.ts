/**
 * 事例の slug 規則。Blob パスとサブドメインの両方に埋め込むので、
 * パストラバーサルや大文字、DNS ラベルとして不正な形を弾く。
 * proxy からも読むため、@vercel/blob などに依存しないこのファイルに置く。
 */
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,40}[a-z0-9])?$/;

export function isValidSlug(slug: string): boolean {
  return SLUG_RE.test(slug);
}
