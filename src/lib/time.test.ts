import { describe, expect, it } from "vitest";
import { binRangeLabel, binStart, binWidthLabel, hhmm, mmdd, nextBin } from "./time";

describe("time", () => {
  it("JST で mmdd / hhmm を返す", () => {
    const at = Date.parse("2026-07-28T16:27:00+09:00");
    expect(mmdd(at)).toBe("07/28");
    expect(hhmm(at)).toBe("16:27");
  });

  it("binStart は binMinutes で JST 境界に切り下げる", () => {
    expect(binStart(Date.parse("2026-08-27T13:45:00+09:00"), 1440)).toBe(Date.parse("2026-08-27T00:00:00+09:00"));
    expect(binStart(Date.parse("2026-07-28T16:27:00+09:00"), 30)).toBe(Date.parse("2026-07-28T16:00:00+09:00"));
  });

  it("nextBin は binMinutes ぶん進める", () => {
    const s = Date.parse("2026-07-28T16:00:00+09:00");
    expect(nextBin(s, 30)).toBe(Date.parse("2026-07-28T16:30:00+09:00"));
    expect(nextBin(s, 1440)).toBe(s + 24 * 60 * 60 * 1000);
  });

  it("binWidthLabel はビン幅を日本語の単位にする", () => {
    expect(binWidthLabel(1440)).toBe("1日");
    expect(binWidthLabel(60)).toBe("1時間");
    expect(binWidthLabel(30)).toBe("30分");
  });

  it("binRangeLabel は JST 1日ちょうどなら日付だけ、それ以外は時刻範囲", () => {
    const d = Date.parse("2026-09-13T00:00:00+09:00");
    expect(binRangeLabel(d, d + 24 * 60 * 60 * 1000)).toBe("09/13");
    const t = Date.parse("2026-07-28T16:00:00+09:00");
    expect(binRangeLabel(t, t + 30 * 60 * 1000)).toBe("07/28 16:00 〜 16:30");
  });
});
