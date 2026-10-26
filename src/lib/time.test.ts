import { describe, expect, it } from "vitest";
import { mmdd, hhmm } from "./time";
describe("time", () => {
  it("JST で mmdd / hhmm を返す", () => {
    const at = Date.parse("2026-07-28T16:27:00+09:00");
    expect(mmdd(at)).toBe("07/28");
    expect(hhmm(at)).toBe("16:27");
  });
});
