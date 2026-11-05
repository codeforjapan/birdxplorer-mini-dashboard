import { describe, expect, it } from "vitest";
import type { TenantRecord, TenantSettings } from "../src/lib/tenant/types";
import { QUIET_MINUTES, rekeyRefusal } from "./tenant-rekey";

type Rec = NonNullable<Parameters<typeof rekeyRefusal>[0]>;

const tenant = (
  over: Partial<Pick<TenantRecord, "status" | "updatedAt" | "searchlightStoppedAt">>,
  s: Partial<TenantSettings> = {},
): Rec => ({
  status: "draft",
  updatedAt: 0,
  searchlightStoppedAt: null,
  settings: { monitorEndDate: "2099-12-31", searchlightTopicId: null, ...s } as TenantSettings,
  ...over,
});

describe("rekeyRefusal", () => {
  const now = Date.parse("2026-11-01T00:00:00+09:00");
  const quiet = now - QUIET_MINUTES * 60_000;

  it("下書きにしてから十分経っていれば通す", () => {
    expect(rekeyRefusal(tenant({ updatedAt: quiet }), now)).toBeNull();
  });

  it("事例が無い・収集中・終了は拒否", () => {
    expect(rekeyRefusal(null, now)).toMatch(/ありません/);
    expect(rekeyRefusal(tenant({ status: "active", updatedAt: quiet }), now)).toMatch(/下書き/);
    expect(rekeyRefusal(tenant({ status: "ended", updatedAt: quiet }), now)).toMatch(/下書き/);
  });

  it("下書きにした直後は、走っている cron を待つよう拒否", () => {
    expect(rekeyRefusal(tenant({ updatedAt: quiet + 1 }), now)).toMatch(/あと約 1 分/);
  });

  it("終了日を過ぎて Searchlight の停止が未記録なら、searchlight-stop と重ならないよう拒否", () => {
    const ended = { monitorEndDate: "2000-01-01", searchlightTopicId: "t1" };
    expect(rekeyRefusal(tenant({ updatedAt: quiet }, ended), now)).toMatch(/Searchlight/);
    expect(rekeyRefusal(tenant({ updatedAt: quiet, searchlightStoppedAt: 1 }, ended), now)).toBeNull();
    expect(rekeyRefusal(tenant({ updatedAt: quiet }, { ...ended, searchlightTopicId: null }), now)).toBeNull();
  });
});
