// All dates are calendar dates in Asia/Jakarta (WIB, UTC+7, no daylight saving), as "YYYY-MM-DD".

const WIB_OFFSET_MS = 7 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export function wibDate(epochMs: number): string {
  return new Date(epochMs + WIB_OFFSET_MS).toISOString().slice(0, 10);
}

/** Slack ts ("1700000000.000100") to WIB date. */
export function slackTsToWibDate(ts: string): string {
  return wibDate(Math.floor(parseFloat(ts) * 1000));
}

function toUtcMs(date: string): number {
  return Date.parse(date + "T00:00:00Z");
}

export function addDays(date: string, n: number): string {
  return new Date(toUtcMs(date) + n * DAY_MS).toISOString().slice(0, 10);
}

/** Monday = 0 ... Sunday = 6. */
export function dayIndex(date: string): number {
  return (new Date(toUtcMs(date)).getUTCDay() + 6) % 7;
}

export function weekStart(date: string): string {
  return addDays(date, -dayIndex(date));
}

export function daysBetween(a: string, b: string): number {
  return Math.round((toUtcMs(b) - toUtcMs(a)) / DAY_MS);
}

const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function dayName(date: string): string {
  return DAY_NAMES[dayIndex(date)];
}

/** "Mon 16 Nov" */
export function shortDate(date: string): string {
  const [, m, d] = date.split("-").map(Number);
  return `${dayName(date)} ${d} ${MONTHS[m - 1]}`;
}
