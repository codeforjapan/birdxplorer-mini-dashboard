import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const authMock = vi.fn();
vi.mock("@/auth", () => ({ auth: () => authMock() }));
const redirectMock = vi.fn((to: string): never => {
  throw new Error(`REDIRECT:${to}`);
});
vi.mock("next/navigation", () => ({ redirect: (to: string) => redirectMock(to) }));

import { requireAdminOrRedirect } from "./session";

beforeEach(() => {
  vi.stubEnv("ADMIN_EMAILS", "ok@x.org");
  authMock.mockReset();
  redirectMock.mockClear();
});
afterEach(() => vi.unstubAllEnvs());

describe("requireAdminOrRedirect", () => {
  it("許可済みは email を返す", async () => {
    authMock.mockResolvedValue({ user: { email: "ok@x.org" } });
    await expect(requireAdminOrRedirect()).resolves.toEqual({ email: "ok@x.org" });
  });
  it("AdminAuthError はログインへ redirect", async () => {
    authMock.mockResolvedValue(null);
    await expect(requireAdminOrRedirect()).rejects.toThrow("REDIRECT:/admin/login");
  });
  it("それ以外のエラーは握りつぶさず再送出", async () => {
    authMock.mockRejectedValue(new Error("MissingSecret"));
    await expect(requireAdminOrRedirect()).rejects.toThrow("MissingSecret");
    expect(redirectMock).not.toHaveBeenCalled();
  });
});
