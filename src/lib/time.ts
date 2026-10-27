/**
 * 時刻ユーティリティ。
 *
 * 表示はすべて JST 固定。ユーザーのローカルタイムゾーンには追従させない
 * （地震発生からの相対時間を読む計器であり、閲覧者の居場所とは無関係）。
 */

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const binMs = (binMinutes: number) => binMinutes * 60 * 1000;

/** ビンの開始時刻に切り下げる。JST の 00:00 を境界に合わせる。 */
export function binStart(at: number, binMinutes: number): number {
  const w = binMs(binMinutes);
  return Math.floor((at + JST_OFFSET_MS) / w) * w - JST_OFFSET_MS;
}

/** ビン幅ぶん進める。 */
export function nextBin(startAt: number, binMinutes: number): number {
  return startAt + binMs(binMinutes);
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

/**
 * 1ビンの範囲を表す見出し文字列。
 *
 * ビン幅が「JST の 00:00 に始まる1日ちょうど」なら日付だけを返す
 * （"09/13 00:00 〜 09/14 00:00" は冗長で、終端の日付が次の日になるため誤読を招く）。
 * 呼び出し側にビン幅の知識を持たせないため、判定はここに閉じ込める。
 */
export function binRangeLabel(startAt: number, endAt: number): string {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const isWholeJstDay = endAt - startAt === DAY_MS && (startAt + JST_OFFSET_MS) % DAY_MS === 0;
  if (isWholeJstDay) return mmdd(startAt);
  return `${mmdd(startAt)} ${hhmm(startAt)} 〜 ${hhmm(endAt)}`;
}

/**
 * ビン幅を日本語の単位表記にする（例: 1440 → "1日"、30 → "30分"）。
 * binMinutes は事例ごとに違い、過去に書き出したスナップショットが別の粒度を持つこともあるため、
 * 定数ではなく引数で受け取る。
 */
export function binWidthLabel(binMinutes: number): string {
  if (binMinutes % 1440 === 0) return `${binMinutes / 1440}日`;
  if (binMinutes % 60 === 0) return `${binMinutes / 60}時間`;
  return `${binMinutes}分`;
}

/** 軸目盛り。日単位のビンでは時刻が常に 00:00 になり意味を持たないので日付を出す。 */
export function binTickLabel(startAt: number, binMinutes: number): string {
  return binMinutes % 1440 === 0 ? mmdd(startAt) : hhmm(startAt);
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
