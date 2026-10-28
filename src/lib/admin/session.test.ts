import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const authMock = vi.fn();
vi.mock("@/auth", () => ({ auth: () => authMock() }));

import { AdminAuthError, requireAdmin } from "./session";

beforeEach(() => {
  vi.stubEnv("ADMIN_EMAILS", "ok@x.org");
  authMock.mockReset();
});
afterEach(() => vi.unstubAllEnvs());

describe("requireAdmin", () => {
  it("セッション無しは拒否", async () => {
    authMock.mockResolvedValue(null);
    await expect(requireAdmin()).rejects.toBeInstanceOf(AdminAuthError);
  });
  it("許可外 email は拒否", async () => {
    authMock.mockResolvedValue({ user: { email: "ng@x.org" } });
    await expect(requireAdmin()).rejects.toBeInstanceOf(AdminAuthError);
  });
  it("ADMIN_EMAILS 未設定は拒否", async () => {
    vi.stubEnv("ADMIN_EMAILS", "");
    authMock.mockResolvedValue({ user: { email: "ok@x.org" } });
    await expect(requireAdmin()).rejects.toBeInstanceOf(AdminAuthError);
  });
  it("許可済みは email を返す", async () => {
    authMock.mockResolvedValue({ user: { email: "OK@x.org" } });
    await expect(requireAdmin()).resolves.toEqual({ email: "ok@x.org" });
  });
});
