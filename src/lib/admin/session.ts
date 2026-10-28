import { auth } from "@/auth";
import { adminEmails } from "@/lib/env";
import { isAllowedEmail } from "./allowlist";

export class AdminAuthError extends Error {
  constructor(message = "管理画面にログインしていないか、許可されていません") {
    super(message);
    this.name = "AdminAuthError";
  }
}

// ログイン後に許可リストから外された人も止めるため、JWT ではなく毎回今のリストと照合する
export async function requireAdmin(): Promise<{ email: string }> {
  const session = await auth();
  const email = session?.user?.email;
  if (!email || !isAllowedEmail(email, adminEmails())) throw new AdminAuthError();
  return { email: email.trim().toLowerCase() };
}
