export function parseAllowlist(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function isAllowedEmail(email: string | null | undefined, allow: Set<string>): boolean {
  if (!email) return false;
  return allow.has(email.trim().toLowerCase());
}
