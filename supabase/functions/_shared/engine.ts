// Budget engine. Plain code, no I/O, same input gives the same output.
//
// Rules:
// - Budget: one amount for each weekday, one for each weekend day (see configureBudgets). Week = Mon-Sun, WIB.
// - Saved money (a finished day's underspend, plus carry-in from last week) pays an overspend first.
// - The rest of a weekday overspend splits equally over the weekdays left. A day never goes below 0.
//   What does not fit goes to the weekend days left, same rule. What still does not fit is floating debt.
// - Saturday overspend goes to Sunday. Sunday overspend becomes floating debt.
// - Sunday close: the saved money left pays the floating debt first, the rest carries to next week.
// - Carry-in is shown as "extra this week". It is not added to the daily budgets.
// - Entries tagged #bill are stored but never count against the budget.

import { addDays, dayIndex, weekStart } from "./dates.ts";

// Defaults. A deployment sets its own amounts with configureBudgets (from the CASHFLOW_*_BUDGET secrets).
export let WEEKDAY_BUDGET = 100_000;
export let WEEKEND_BUDGET = 300_000;
export let BASE_BUDGETS: number[] = [];
export let WEEK_BUDGET = 0;

export function configureBudgets(weekday: number, weekend: number): void {
  if (!Number.isInteger(weekday) || !Number.isInteger(weekend) || weekday < 0 || weekend < 0) {
    throw new Error(`budgets must be whole numbers >= 0, got ${weekday} and ${weekend}`);
  }
  WEEKDAY_BUDGET = weekday;
  WEEKEND_BUDGET = weekend;
  BASE_BUDGETS = [weekday, weekday, weekday, weekday, weekday, weekend, weekend];
  WEEK_BUDGET = BASE_BUDGETS.reduce((a, b) => a + b, 0);
}
configureBudgets(WEEKDAY_BUDGET, WEEKEND_BUDGET);

export interface Entry {
  date: string; // WIB "YYYY-MM-DD"
  amount: number; // IDR, integer, may be negative (refund)
  bill: boolean;
}

export interface WeekResult {
  weekStart: string;
  carryIn: number;
  debtIn: number;
  budgets: number[]; // the budget of each day after the moves
  spent: number[]; // spend of each day (bills excluded)
  pool: number; // saved money not used yet ("extra this week")
  weekDebt: number; // floating debt made in this week
  /** Index of "today" (0-6), or 7 when the whole week is in the past. */
  upTo: number;
  closed: boolean;
  carryOut: number; // only when closed
  debtOut: number; // when closed: after the close; else debtIn + weekDebt
}

/** Take `amount` out of the given days, equally, never below 0. Returns what did not fit. */
function spread(budgets: number[], days: number[], amount: number): number {
  while (amount > 0) {
    const active = days.filter((d) => budgets[d] > 0);
    if (active.length === 0) return amount;
    const share = Math.floor(amount / active.length);
    const rest = amount - share * active.length;
    let moved = 0;
    active.forEach((d, k) => {
      const want = share + (k === active.length - 1 ? rest : 0);
      const take = Math.min(budgets[d], want);
      budgets[d] -= take;
      moved += take;
    });
    amount -= moved;
    if (moved === 0) return amount;
  }
  return 0;
}

function range(from: number, to: number): number[] {
  const out: number[] = [];
  for (let i = from; i <= to; i++) out.push(i);
  return out;
}

export function computeWeek(
  start: string,
  spent: number[],
  carryIn: number,
  debtIn: number,
  upTo: number,
): WeekResult {
  const budgets = [...BASE_BUDGETS];
  let pool = carryIn;
  let weekDebt = 0;

  for (let i = 0; i <= Math.min(upTo, 6); i++) {
    let over = spent[i] - budgets[i];
    if (over > 0) {
      const use = Math.min(pool, over);
      pool -= use;
      over -= use;
      if (i <= 4) over = spread(budgets, range(i + 1, 4), over);
      if (i <= 5) over = spread(budgets, range(Math.max(i + 1, 5), 6), over);
      weekDebt += over;
    } else if (i < upTo) {
      pool += -over; // a finished day's underspend becomes saved money
    }
  }

  const closed = upTo >= 7;
  let carryOut = 0;
  let debtOut = debtIn + weekDebt;
  if (closed) {
    const pay = Math.min(pool, debtOut);
    debtOut -= pay;
    carryOut = pool - pay;
  }
  return { weekStart: start, carryIn, debtIn, budgets, spent: [...spent], pool, weekDebt, upTo, closed, carryOut, debtOut };
}

export interface Ledger {
  weeks: WeekResult[]; // oldest first; the last one is the current week
  current: WeekResult;
  today: string;
}

/** Replays every week from `startDate` up to `today`. Edits anywhere in the past just work. */
export function computeLedger(entries: Entry[], startDate: string, today: string): Ledger {
  const first = weekStart(startDate);
  const thisWeek = weekStart(today);
  const byDate = new Map<string, number>();
  for (const e of entries) {
    if (e.bill || e.date < startDate || e.date > today) continue;
    byDate.set(e.date, (byDate.get(e.date) ?? 0) + e.amount);
  }

  const weeks: WeekResult[] = [];
  let carry = 0;
  let debt = 0;
  for (let ws = first; ws <= thisWeek; ws = addDays(ws, 7)) {
    const spent = range(0, 6).map((i) => byDate.get(addDays(ws, i)) ?? 0);
    const upTo = ws === thisWeek ? dayIndex(today) : 7;
    const w = computeWeek(ws, spent, carry, debt, upTo);
    weeks.push(w);
    carry = w.carryOut;
    debt = w.debtOut;
  }
  return { weeks, current: weeks[weeks.length - 1], today };
}

export interface Status {
  today: string;
  todayBudget: number;
  spentToday: number;
  leftToday: number;
  overToday: number;
  coveredByExtra: number; // part of today's overspend paid by saved money
  spentWeek: number;
  leftWeek: number; // WEEK_BUDGET + carryIn - spentWeek (can be < 0)
  tomorrowBudget: number;
  tomorrowBase: number;
  extra: number;
  floatingDebt: number;
  /** Where today's overspend went, after saved money paid its part: later days (0-6) and floating debt. */
  movedTo: { day: number; amount: number }[];
  toDebt: number;
}

export function status(ledger: Ledger): Status {
  const w = ledger.current;
  const t = w.upTo;
  const todayBudget = w.budgets[t];
  const spentToday = w.spent[t];
  const spentWeek = w.spent.reduce((a, b) => a + b, 0);
  const overToday = Math.max(0, spentToday - todayBudget);

  // How much of today's overspend saved money paid: compare with the pool before today.
  const before = computeWeek(w.weekStart, w.spent.map((s, i) => (i === t ? 0 : s)), w.carryIn, w.debtIn, t);
  const coveredByExtra = Math.min(overToday, before.pool);
  const movedTo: { day: number; amount: number }[] = [];
  for (let j = t + 1; j < 7; j++) {
    const cut = before.budgets[j] - w.budgets[j];
    if (cut > 0) movedTo.push({ day: j, amount: cut });
  }
  const toDebt = w.weekDebt - before.weekDebt;

  return {
    today: ledger.today,
    todayBudget,
    spentToday,
    leftToday: Math.max(0, todayBudget - spentToday),
    overToday,
    coveredByExtra,
    spentWeek,
    leftWeek: WEEK_BUDGET + w.carryIn - spentWeek,
    tomorrowBudget: t < 6 ? w.budgets[t + 1] : WEEKDAY_BUDGET,
    tomorrowBase: t < 6 ? BASE_BUDGETS[t + 1] : WEEKDAY_BUDGET,
    extra: w.pool,
    floatingDebt: w.debtIn + w.weekDebt,
    movedTo,
    toDebt,
  };
}

/** Sum of #bill entries in the calendar month of `today`. */
export function billsThisMonth(entries: Entry[], today: string): number {
  const month = today.slice(0, 7);
  return entries.filter((e) => e.bill && e.date.slice(0, 7) === month && e.date <= today)
    .reduce((a, e) => a + e.amount, 0);
}

