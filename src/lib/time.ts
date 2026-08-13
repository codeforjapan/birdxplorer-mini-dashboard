import { BIN_MINUTES } from "./constants";

/**
 * 時刻ユーティリティ。
 *
 * 表示はすべて JST 固定。ユーザーのローカルタイムゾーンには追従させない
 * （地震発生からの相対時間を読む計器であり、閲覧者の居場所とは無関係）。
 */

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const BIN_MS = BIN_MINUTES * 60 * 1000;

/** ビンの開始時刻に切り下げる。JST の 00:00 を境界に合わせる。 */
export function binStart(at: number): number {
  return Math.floor((at + JST_OFFSET_MS) / BIN_MS) * BIN_MS - JST_OFFSET_MS;
}

/** ビン幅ぶん進める。 */
export function nextBin(startAt: number): number {
  return startAt + BIN_MS;
}

function jstParts(at: number) {
  const d = new Date(at + JST_OFFSET_MS);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
  };
}

const p2 = (n: number) => String(n).padStart(2, "0");

/** "16:27" */
export function hhmm(at: number): string {
  const { hour, minute } = jstParts(at);
  return `${p2(hour)}:${p2(minute)}`;
}

/** "07/28" */
export function mmdd(at: number): string {
  const { month, day } = jstParts(at);
  return `${p2(month)}/${p2(day)}`;
}

/** "07/28 16:27" */
export function mmddhhmm(at: number): string {
  return `${mmdd(at)} ${hhmm(at)}`;
}

/** "2026-07-28"。日次レポートのキーやURLに使う。 */
export function isoDate(at: number): string {
  const { year, month, day } = jstParts(at);
  return `${year}-${p2(month)}-${p2(day)}`;
}

/** "2026-07-28 16:27 JST"。最終更新時刻の表示に使う。 */
export function stampJst(at: number): string {
  return `${isoDate(at)} ${hhmm(at)} JST`;
}

/** JST の日付文字列 "YYYY-MM-DD" を、その日の 00:00 JST の epoch ms に変換する。 */
export function jstDateStart(isoDay: string): number {
  return Date.parse(`${isoDay}T00:00:00+09:00`);
}

/** "YYYY-MM-DD" を "2026年8月31日" 形式に変換する。収集終了メッセージ等の表示に使う。 */
export function jstDateLabel(isoDay: string): string {
  const [year, month, day] = isoDay.split("-").map(Number);
  return `${year}年${month}月${day}日`;
}

/** 日次ダイジェストの対象範囲: 前日15:00 JST 〜 当日15:00 JST。 */
export function digestWindow(reportAt: number): { from: number; to: number } {
  const { year, month, day } = jstParts(reportAt);
  const to = Date.parse(`${year}-${p2(month)}-${p2(day)}T15:00:00+09:00`);
  return { from: to - 24 * 60 * 60 * 1000, to };
}
