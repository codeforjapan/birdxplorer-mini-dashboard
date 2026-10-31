/**
 * 管理画面は ADMIN_ORIGIN のホストでだけ開く（ログインの cookie と OAuth のコールバックを1か所に固定するため）。
 * 違うホスト（事例のサブドメイン等）で開かれたら、同じパスの ADMIN_ORIGIN 側 URL を返す。
 */
export function adminRedirectTarget(
  host: string | null,
  path: string,
  adminOrigin: string,
): string | null {
  const origin = new URL(adminOrigin);
  if (host !== null && host.trim().toLowerCase() === origin.host.toLowerCase()) return null;
  return `${origin.origin}${path}`;
}

/** proxy から呼ぶので、ADMIN_ORIGIN が未設定・不正でも例外にしない */
export function isAdminHost(host: string | null, adminOrigin: string | undefined): boolean {
  if (host === null || !adminOrigin) return false;
  try {
    return host.trim().toLowerCase() === new URL(adminOrigin).host.toLowerCase();
  } catch {
    return false;
  }
}
