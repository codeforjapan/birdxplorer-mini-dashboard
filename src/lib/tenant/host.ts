import { isValidSlug } from "./slug";

/**
 * ホスト名から事例を引く。引けないときは既定の事例に落とさず null を返す
 * （登録の無いホストで別の事例が表示されるのを防ぐため）。
 */

export type HostRules = { parentDomain: string | null; aliases: Record<string, string> };

// サブドメインとしては有効でも事例ではないもの
const RESERVED_LABELS = new Set(["www"]);

function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/:\d+$/, "");
}

// parseHostRules はリクエストごとに呼ばれるので、設定の不備はインスタンスにつき1回だけ出す
let warned = false;

/**
 * 設定が壊れていてもページ全体を落とさず、引けるものだけ引けるようにする。
 * ただし黙って捨てると「その事例だけ 404」の原因を追えないので、捨てたものはログに出す。
 */
export function parseHostRules(env: {
  TENANT_PARENT_DOMAIN?: string;
  TENANT_HOST_ALIASES?: string;
}): HostRules {
  const parent = normalizeHost(env.TENANT_PARENT_DOMAIN ?? "");
  const aliases: Record<string, string> = {};
  const problems: string[] = [];
  if (parent === "") problems.push("TENANT_PARENT_DOMAIN が未設定（サブドメインからは事例を引かない）");

  let raw: unknown = null;
  try {
    raw = JSON.parse(env.TENANT_HOST_ALIASES ?? "null");
  } catch {
    problems.push("TENANT_HOST_ALIASES が JSON として読めない（別名を全て無視）");
  }
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    for (const [host, slug] of Object.entries(raw)) {
      if (typeof slug === "string" && isValidSlug(slug)) aliases[normalizeHost(host)] = slug;
      else problems.push(`TENANT_HOST_ALIASES の ${JSON.stringify(host)} は slug が不正なので無視`);
    }
  } else if (raw !== null) {
    problems.push("TENANT_HOST_ALIASES がオブジェクトでない（別名を全て無視）");
  }

  if (problems.length > 0 && !warned) {
    warned = true;
    console.error(`[tenant-host] ホスト設定の不備: ${problems.join(" / ")}`);
  }
  return { parentDomain: parent === "" ? null : parent, aliases };
}

export function resolveSlugFromHost(host: string | null, rules: HostRules): string | null {
  if (!host) return null;
  const h = normalizeHost(host);

  const alias = Object.hasOwn(rules.aliases, h) ? rules.aliases[h] : undefined;
  if (alias !== undefined) return alias;

  if (!rules.parentDomain) return null;
  const suffix = `.${rules.parentDomain}`;
  if (!h.endsWith(suffix)) return null;
  const label = h.slice(0, -suffix.length);
  // 直下1階層だけ（a.b.parent を a.b という事例として扱わない）
  if (label.includes(".") || RESERVED_LABELS.has(label) || !isValidSlug(label)) return null;
  return label;
}
