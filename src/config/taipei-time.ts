/**
 * Taipei wall-clock helpers.
 *
 * Every GTFS/TDX timetable in this codebase is keyed to Asia/Taipei, but the
 * server's local timezone is whatever the host happens to run (nothing pins
 * TZ in docker-compose or the env). Date#getHours()/getDay()/getDate() etc.
 * therefore must never be used for scheduling decisions — route all
 * "what time/day is it" math through these helpers instead.
 *
 * Taiwan has no DST, so Asia/Taipei is a constant UTC+8; the wall-clock
 * constructors below rely on that.
 */

const TPE_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: "Asia/Taipei",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  weekday: "short",
  hourCycle: "h23",
});

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

export interface TaipeiParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number;
}

/**
 * Decompose an instant into Taipei wall-clock components.
 *
 * @param d The instant to decompose (defaults to now).
 * @returns The Taipei wall-clock components of `d`.
 */
export function taipeiParts(d: Date = new Date()): TaipeiParts {
  const parts: Record<string, string> = {};
  for (const { type, value } of TPE_FMT.formatToParts(d)) parts[type] = value;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: WEEKDAY_INDEX[parts.weekday] ?? 0,
  };
}

/**
 * 0 = Sunday … 6 = Saturday, in Taipei.
 *
 * @param d The instant to evaluate (defaults to now).
 * @returns The Taipei weekday index (0 = Sunday … 6 = Saturday).
 */
export function taipeiWeekday(d: Date = new Date()): number {
  return taipeiParts(d).weekday;
}

/**
 * Minutes since Taipei midnight (0–1439).
 *
 * @param d The instant to evaluate (defaults to now).
 * @returns Minutes since Taipei midnight (0–1439).
 */
export function taipeiMinutesOfDay(d: Date = new Date()): number {
  const p = taipeiParts(d);
  return p.hour * 60 + p.minute;
}

/**
 * Seconds since Taipei midnight (0–86399).
 *
 * @param d The instant to evaluate (defaults to now).
 * @returns Seconds since Taipei midnight (0–86399).
 */
export function taipeiSecondsOfDay(d: Date = new Date()): number {
  const p = taipeiParts(d);
  return p.hour * 3600 + p.minute * 60 + p.second;
}

const p2 = (n: number) => String(n).padStart(2, "0");

/**
 * Taipei date as "YYYYMMDD" (GTFS calendar format).
 *
 * @param d The instant to format (defaults to now).
 * @returns The Taipei date as "YYYYMMDD".
 */
export function taipeiYmd(d: Date = new Date()): string {
  const p = taipeiParts(d);
  return `${p.year}${p2(p.month)}${p2(p.day)}`;
}

/**
 * Taipei date as "YYYY-MM-DD".
 *
 * @param d The instant to format (defaults to now).
 * @returns The Taipei date as "YYYY-MM-DD".
 */
export function taipeiYmdDash(d: Date = new Date()): string {
  const p = taipeiParts(d);
  return `${p.year}-${p2(p.month)}-${p2(p.day)}`;
}

/**
 * Taipei clock as "HH:mm".
 *
 * @param d The instant to format (defaults to now).
 * @returns The Taipei clock as "HH:mm".
 */
export function taipeiHHmm(d: Date = new Date()): string {
  const p = taipeiParts(d);
  return `${p2(p.hour)}:${p2(p.minute)}`;
}

/**
 * Taipei datetime as "YYYY-MM-DDTHH:mm:ss" (TDX API query format).
 *
 * @param d The instant to format (defaults to now).
 * @returns The Taipei datetime as "YYYY-MM-DDTHH:mm:ss".
 */
export function taipeiIsoLocal(d: Date = new Date()): string {
  const p = taipeiParts(d);
  return `${p.year}-${p2(p.month)}-${p2(p.day)}T${p2(p.hour)}:${p2(p.minute)}:${p2(p.second)}`;
}

/**
 * The instant corresponding to the given Taipei wall-clock time on the same
 * Taipei calendar date as `d`. Exact because Asia/Taipei is fixed UTC+8.
 *
 * @param d The reference instant whose Taipei calendar date is used.
 * @param hour The Taipei wall-clock hour.
 * @param minute The Taipei wall-clock minute.
 * @param second The Taipei wall-clock second.
 * @returns The instant for that Taipei wall-clock time.
 */
export function taipeiWallClock(
  d: Date,
  hour: number,
  minute = 0,
  second = 0,
): Date {
  const p = taipeiParts(d);
  return new Date(
    Date.UTC(p.year, p.month - 1, p.day, hour - 8, minute, second),
  );
}

/**
 * The instant n×24h later — safe day arithmetic for a DST-free zone.
 *
 * @param d The starting instant.
 * @param n The number of days to add.
 * @returns The instant n×24h later.
 */
export function addTaipeiDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * 86_400_000);
}
