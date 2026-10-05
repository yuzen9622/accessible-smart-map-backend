import { STOP_STATUS_LABEL } from "../../constants/bus";
import { equalStopName } from "../../utils/transit-text";
import {
  addTaipeiDays,
  taipeiHHmm,
  taipeiWeekday,
  taipeiYmd,
} from "../../config/taipei-time";
import type { BusFrequency } from "./transit.types";

const WEEKDAY_ZH = ["日", "一", "二", "三", "四", "五", "六"];
const NO_REALTIME_STATUSES = new Set([0, 1, 3, 4]);
const NO_ETA_LABEL = "暫無到站資訊";

/**
 * Whether a schedule entry's service-day label (from serviceDayLabel) covers a weekday.
 *
 * @param label "每日" | "平日" | "假日" | "週一三…" | "" (unknown → assumed to run).
 * @param weekday 0 = Sunday … 6 = Saturday.
 * @returns True when the entry runs on that weekday.
 */
export function runsOnWeekday(label: string, weekday: number): boolean {
  if (!label || label === "每日") return true;
  if (label === "平日") return weekday >= 1 && weekday <= 5;
  if (label === "假日") return weekday === 0 || weekday === 6;
  if (label.startsWith("週")) return label.includes(WEEKDAY_ZH[weekday]);
  return true;
}

type Departure = { time: string; atStop: boolean };

/**
 * Departures of one service day that this stop can use, in time order.
 *
 * @param frequencies The direction's published schedule entries.
 * @param weekday The service day's weekday.
 * @param stopName The queried stop, used to pick a per-stop time when published.
 * @returns Discrete trip times plus headway-window start times.
 */
function departuresOn(
  frequencies: BusFrequency[],
  weekday: number,
  stopName: string,
): Departure[] {
  const out: Departure[] = [];
  for (const f of frequencies) {
    if (!runsOnWeekday(f.serviceDays, weekday)) continue;
    if (f.scheduleType === "trip") {
      const atStop = f.stopTimes?.find((st) =>
        equalStopName(st.stopName, stopName),
      );
      if (atStop?.arrivalTime)
        out.push({ time: atStop.arrivalTime, atStop: true });
      else if (f.originDepartureTime)
        out.push({
          time: f.originDepartureTime,
          atStop: equalStopName(f.originStopName, stopName),
        });
    } else if (f.start) {
      out.push({ time: f.start, atStop: false });
    }
  }
  return out.sort((a, b) => a.time.localeCompare(b.time));
}

/**
 * Headway text for a window that is in service right now.
 *
 * @param frequencies The direction's published schedule entries.
 * @param weekday Today's weekday.
 * @param nowHHmm Current Taipei time.
 * @returns "每 7–10 分一班" style text, or null when no window covers now.
 */
function activeHeadwayText(
  frequencies: BusFrequency[],
  weekday: number,
  nowHHmm: string,
): string | null {
  for (const f of frequencies) {
    if (f.scheduleType !== "headway" || !f.start || !f.end) continue;
    if (!runsOnWeekday(f.serviceDays, weekday)) continue;
    if (f.start > nowHHmm || f.end <= nowHHmm) continue;
    const { minHeadwayMins: min, maxHeadwayMins: max } = f;
    if (min == null && max == null) return "班距發車中";
    if (min == null || max == null || min === max)
      return `每 ${min ?? max} 分一班`;
    return `每 ${min}–${max} 分一班`;
  }
  return null;
}

/**
 * Next scheduled departure for a stop when no live estimate exists: later today,
 * otherwise the first departure of the next service day within a week.
 *
 * @param frequencies The direction's published schedule entries.
 * @param stopName The queried stop.
 * @param isFirstStop Whether the stop is the route's origin.
 * @param now The reference instant.
 * @returns e.g. "14:30", "明日 05:30 起點發車", "週一 06:00 起點發車", "每 7–10 分一班"; null without schedule data.
 */
export function nextDepartureText(
  frequencies: BusFrequency[],
  stopName: string,
  isFirstStop: boolean,
  now: Date = new Date(),
): string | null {
  if (!frequencies.length) return null;
  const nowHHmm = taipeiHHmm(now);
  const today = taipeiWeekday(now);

  const headway = activeHeadwayText(frequencies, today, nowHHmm);
  if (headway) return headway;

  for (let offset = 0; offset <= 7; offset++) {
    const weekday = (today + offset) % 7;
    const candidates = departuresOn(frequencies, weekday, stopName).filter(
      (d) => offset > 0 || d.time >= nowHHmm,
    );
    const next = candidates[0];
    if (!next) continue;
    const prefix =
      offset === 0 ? "" : offset === 1 ? "明日 " : `週${WEEKDAY_ZH[weekday]} `;
    const suffix = next.atStop || isFirstStop ? "" : " 起點發車";
    return `${prefix}${next.time}${suffix}`;
  }
  return null;
}

/**
 * Formats TDX N1 NextBusTime, marking departures that fall on a later Taipei
 * date; a time already in the past is stale and dropped so the timetable wins.
 *
 * @param iso NextBusTime as published by TDX.
 * @param now The reference instant.
 * @returns "HH:mm" or "明日 HH:mm"; null when absent, unparseable or past.
 */
export function formatNextBusTime(
  iso: string | undefined,
  now: Date = new Date(),
): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime()) || d.getTime() < now.getTime() - 60_000) return null;
  const hhmm = taipeiHHmm(d);
  if (taipeiYmd(d) === taipeiYmd(now)) return hhmm;
  if (taipeiYmd(d) === taipeiYmd(addTaipeiDays(now, 1))) return `明日 ${hhmm}`;
  return `${taipeiYmd(d).slice(4, 6)}/${taipeiYmd(d).slice(6)} ${hhmm}`;
}

/**
 * Display label for one stop's ETA. A live estimate always wins; otherwise the
 * next scheduled bus replaces placeholder statuses (尚未發車 / 末班車已過 /
 * 今日未營運) so callers are never left with a bare "not departed".
 *
 * @param input.estimateMinutes Live estimate, null when TDX has none.
 * @param input.stopStatus TDX N1 StopStatus; undefined when the stop had no N1 record.
 * @param input.nextBusTime Formatted NextBusTime, when TDX published one.
 * @param input.scheduled Lazily computes the next scheduled departure.
 * @returns The label to show.
 */
export function resolveStopStatusLabel(input: {
  estimateMinutes: number | null;
  stopStatus: number | undefined;
  nextBusTime: string | null;
  scheduled: () => string | null;
}): string {
  const { estimateMinutes, stopStatus, nextBusTime } = input;
  const upstream =
    stopStatus === undefined ? undefined : STOP_STATUS_LABEL[stopStatus];
  if (estimateMinutes != null)
    return stopStatus === 1 || !upstream ? "正常" : upstream;
  if (stopStatus !== undefined && !NO_REALTIME_STATUSES.has(stopStatus))
    return upstream ?? NO_ETA_LABEL;
  const placeholder = stopStatus === 0 ? undefined : upstream;
  return nextBusTime ?? input.scheduled() ?? placeholder ?? NO_ETA_LABEL;
}
