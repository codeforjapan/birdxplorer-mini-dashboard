import { isAllowedEmail } from "./allowlist";

type SignInParams = {
  user: { email?: string | null };
  account?: { provider: string } | null;
  profile?: { email_verified?: unknown };
};

// 未検証のメールは他人が名乗れるので、許可リストに載っていても通さない
export function isAllowedSignIn({ user, account, profile }: SignInParams, allow: Set<string>): boolean {
  return account?.provider === "google" && profile?.email_verified === true && isAllowedEmail(user.email, allow);
}
