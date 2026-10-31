/**
 * 事例の slug（識別子）とホスト名ラベルの規則。
 * slug は作成時にシステムが採番する変わらない識別子で、DB の tenant_id と Blob のパスに入る。
 * ホスト名ラベルは公開 URL のサブドメインで、後から変えられる。
 * どちらも Blob パスやサブドメインに埋め込むので、パストラバーサルや大文字、DNS ラベルとして不正な形を弾く。
 * proxy からも読むため、@vercel/blob などに依存しないこのファイルに置く。
 */
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,40}[a-z0-9])?$/;

export function isValidSlug(slug: string): boolean {
  return SLUG_RE.test(slug);
}

// サブドメインとしては有効でも事例ではないもの
const RESERVED_HOST_LABELS = new Set(["www"]);

export function isValidHostLabel(label: string): boolean {
  return SLUG_RE.test(label) && !RESERVED_HOST_LABELS.has(label);
}

const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const ID_LENGTH = 10;

/**
 * 新しい事例の slug。連番にしないのは、手元の DB と試験環境の Blob をつないで確かめるときに、
 * DB ごとに同じ番号が振られて他の事例の Blob を上書きしないようにするため。
 */
export function generateTenantId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(ID_LENGTH));
  // 256 は 36 で割り切れないので先頭の文字がわずかに出やすいが、衝突の起きにくさには効かない
  return Array.from(bytes, (b) => ID_ALPHABET[b % ID_ALPHABET.length]).join("");
}
