// Reply text: one bold answer line, then the note, then one grey (italic) context line.
// Icons have different shapes, and a word is always next to the icon (colour is not the only signal).

import { addDays, dayName, shortDate } from "./dates.ts";
import { BASE_BUDGETS, type Status, WEEK_BUDGET, type WeekResult } from "./engine.ts";
import { dayIndex } from "./dates.ts";
import { rupiah } from "./parse.ts";

export interface Logged { amount: number; note: string; who: string; date: string; bill: boolean }
export interface ReplyOptions { corrected?: boolean; fromChannel?: boolean }

const DAY = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** "Wed-Fri" for a run of days, else "Wed, Sat". */
function dayList(days: number[]): string {
  if (days.length === 0) return "";
  const run = days.every((d, i) => i === 0 || d === days[i - 1] + 1);
  if (days.length === 1) return DAY[days[0]];
  return run ? `${DAY[days[0]]}-${DAY[days[days.length - 1]]}` : days.map((d) => DAY[d]).join(", ");
}

function weekText(leftWeek: number): string {
  return leftWeek >= 0 ? `Week ${rupiah(leftWeek)} left` : `Week ${rupiah(-leftWeek)} over`;
}

function tomorrowText(s: Status): string {
  const was = s.tomorrowBudget !== s.tomorrowBase ? ` (was ${rupiah(s.tomorrowBase)})` : "";
  return `Tomorrow ${rupiah(s.tomorrowBudget)}${was}`;
}

function noteLine(l: Logged, today: string, o: ReplyOptions): string {
  const parts = [l.note ? `${rupiah(l.amount)} ${l.note}` : rupiah(l.amount), l.who];
  if (l.date !== today) parts.push(`for ${shortDate(l.date)}`);
  if (o.corrected) parts.push("corrected");
  return parts.join(" · ");
}

const hintLine = "_Logged from the channel. Next time, reply in this thread._";

/** The reply after a spend or a bill. */
export function spendReply(s: Status, l: Logged, bills: number, o: ReplyOptions = {}): string {
  const lines: string[] = [];
  if (l.bill) {
    lines.push(`:receipt: *Bill logged: ${rupiah(l.amount)}*`);
    const parts = [l.note || "bill", l.who];
    if (l.date !== s.today) parts.push(`for ${shortDate(l.date)}`);
    if (o.corrected) parts.push("corrected");
    lines.push(parts.join(" · "));
    lines.push(`_Not in the budget · Bills this month ${rupiah(bills)}_`);
  } else {
    if (s.overToday > 0) {
      lines.push(`:warning: *Over today by ${rupiah(s.overToday)}*`);
      const where: string[] = [];
      if (s.coveredByExtra > 0) where.push(`Extra paid ${rupiah(s.coveredByExtra)}`);
      const moved = s.movedTo.reduce((a, m) => a + m.amount, 0);
      if (moved > 0) where.push(`${rupiah(moved)} moved to ${dayList(s.movedTo.map((m) => m.day))}`);
      if (s.toDebt > 0) where.push(`${rupiah(s.toDebt)} to floating debt`);
      if (where.length) lines.push(where.join(" · "));
    } else {
      lines.push(`:white_check_mark: *${rupiah(s.leftToday)} left today*`);
    }
    lines.push(noteLine(l, s.today, o));
    lines.push(`_Spent today ${rupiah(s.spentToday)} · ${weekText(s.leftWeek)} · ${tomorrowText(s)}_`);
  }
  if (o.fromChannel) lines.push(hintLine);
  return lines.join("\n");
}

/** The reply after a message with one or more spends. One line for each spend, then who and the total. */
export function spendsReply(s: Status, items: Logged[], bills: number, o: ReplyOptions = {}): string {
  if (items.length === 1) return spendReply(s, items[0], bills, o);
  const lines: string[] = [];
  if (s.overToday > 0) {
    lines.push(`:warning: *Over today by ${rupiah(s.overToday)}*`);
    const where: string[] = [];
    if (s.coveredByExtra > 0) where.push(`Extra paid ${rupiah(s.coveredByExtra)}`);
    const moved = s.movedTo.reduce((a, m) => a + m.amount, 0);
    if (moved > 0) where.push(`${rupiah(moved)} moved to ${dayList(s.movedTo.map((m) => m.day))}`);
    if (s.toDebt > 0) where.push(`${rupiah(s.toDebt)} to floating debt`);
    if (where.length) lines.push(where.join(" · "));
  } else {
    lines.push(`:white_check_mark: *${rupiah(s.leftToday)} left today*`);
  }
  for (const l of items) {
    const parts = [l.note ? `${rupiah(l.amount)} ${l.note}` : rupiah(l.amount)];
    if (l.date !== s.today) parts.push(`for ${shortDate(l.date)}`);
    if (l.bill) parts.push("bill, not in the budget");
    lines.push("• " + parts.join(" · "));
  }
  const total = items.reduce((a, l) => a + l.amount, 0);
  const tail = [`${items.length} items, ${rupiah(total)}`, items[0].who];
  if (o.corrected) tail.push("corrected");
  lines.push(tail.join(" · "));
  const ctx = [`Spent today ${rupiah(s.spentToday)}`, weekText(s.leftWeek), tomorrowText(s)];
  if (items.some((l) => l.bill)) ctx.push(`Bills this month ${rupiah(bills)}`);
  lines.push(`_${ctx.join(" · ")}_`);
  if (o.fromChannel) lines.push(hintLine);
  return lines.join("\n");
}

/** The bot's reply after the spend message was deleted, or edited to have no amount. */
export function removedReply(s: Status, amount: number, note: string, who: string): string {
  const what = note ? `${rupiah(amount)} ${note}` : rupiah(amount);
  return [
    `:wastebasket: *Removed ${what}*`,
    who,
    `_Spent today ${rupiah(s.spentToday)} · ${weekText(s.leftWeek)} · ${tomorrowText(s)}_`,
  ].join("\n");
}

/** `/spent week`: the full picture, on demand. */
export function statusText(s: Status, bills: number): string {
  const head = s.overToday > 0
    ? `:warning: *Over today by ${rupiah(s.overToday)}*`
    : `:white_check_mark: *${rupiah(s.leftToday)} left today*`;
  const lines = [
    `*${shortDate(s.today)}* · ${head}`,
    `Spent today ${rupiah(s.spentToday)} of ${rupiah(s.todayBudget)}`,
    `${weekText(s.leftWeek)} · ${tomorrowText(s)} (${dayName(addDays(s.today, 1))})`,
  ];
  const extras: string[] = [];
  if (s.extra > 0) extras.push(`Extra this week ${rupiah(s.extra)}`);
  if (s.floatingDebt > 0) extras.push(`Floating debt ${rupiah(s.floatingDebt)}`);
  if (bills > 0) extras.push(`Bills this month ${rupiah(bills)}`);
  if (extras.length) lines.push(`_${extras.join(" · ")}_`);
  return lines.join("\n");
}

/** The parent message of a day's thread. */
export function dayHeaderText(s: Status): string {
  const base = baseOf(s.today);
  const was = s.todayBudget !== base ? ` (was ${rupiah(base)})` : "";
  const first = `*${shortDate(s.today)}* · ${rupiah(s.todayBudget)} to spend today${was} · ${weekText(s.leftWeek)}`;
  const extras: string[] = [];
  if (s.extra > 0) extras.push(`Extra this week ${rupiah(s.extra)}`);
  if (s.floatingDebt > 0) extras.push(`Floating debt ${rupiah(s.floatingDebt)}`);
  const lines = [first];
  if (extras.length) lines.push(extras.join(" · "));
  lines.push(`_Reply in this thread with your spending, like "50rb bakso"._`);
  return lines.join("\n");
}

function baseOf(date: string): number {
  return BASE_BUDGETS[dayIndex(date)];
}

export function reminderInThread(today: string): string {
  return `:bell: ${shortDate(today)}: please input your spending in this thread, or "0" for no spend.`;
}

export function weekCloseText(w: WeekResult): string {
  const spent = w.spent.reduce((a, b) => a + b, 0);
  const lines = [
    `*Week of ${shortDate(w.weekStart)} closed* · spent ${rupiah(spent)} of ${rupiah(WEEK_BUDGET + w.carryIn)}`,
  ];
  if (w.carryOut > 0) lines.push(`Carries to next week ${rupiah(w.carryOut)}`);
  if (w.debtOut > 0) lines.push(`Floating debt ${rupiah(w.debtOut)}`);
  if (w.carryOut === 0 && w.debtOut === 0) lines.push(`Exactly on budget`);
  lines.push(`_CSV backup below._`);
  return lines.join("\n");
}
