import { test } from "node:test";
import assert from "node:assert/strict";
import { computeWeek, computeLedger, configureBudgets, status, billsThisMonth, WEEK_BUDGET } from "../supabase/functions/_shared/engine.ts";
import { addDays } from "../supabase/functions/_shared/dates.ts";

// Default budgets: 100.000 a weekday, 300.000 a weekend day, 1.100.000 a week.
const K = 1_000;
const MON = "2026-11-23"; // a Monday

test("defaults: 100.000 a weekday, 300.000 a weekend day", () => {
  assert.equal(WEEK_BUDGET, 1_100 * K);
});

test("Monday 160.000 -> Tue-Fri 85.000 each, left this week 940.000", () => {
  const w = computeWeek(MON, [160 * K, 0, 0, 0, 0, 0, 0], 0, 0, 0);
  assert.deepEqual(w.budgets, [100, 85, 85, 85, 85, 300, 300].map((x) => x * K));
  const s = status(computeLedger([{ date: MON, amount: 160 * K, bill: false }], MON, MON));
  assert.equal(s.leftWeek, 940 * K);
  assert.equal(s.overToday, 60 * K);
  assert.equal(s.tomorrowBudget, 85 * K);
});

test("a full week 125.000 over ends with floating debt 125.000 and no carry", () => {
  const spent = [150_000, 50_000, 87_500, 87_500, 250_000, 400_000, 200_000];
  const w = computeWeek(MON, spent, 0, 0, 7);
  // Mon over 50 -> Tue-Fri 87,5. Tue saves 37,5. Fri over 162,5: 37,5 paid by extra, 125 -> Sat/Sun 237,5.
  // Sat over 162,5 -> Sun 75. Sun over 125 -> floating debt.
  assert.deepEqual(w.budgets, [100_000, 87_500, 87_500, 87_500, 87_500, 237_500, 75_000]);
  assert.equal(w.weekDebt, 125 * K);
  assert.equal(w.debtOut, 125 * K);
  assert.equal(w.carryOut, 0);
});

test("saved money pays first: Tue saves 35.000, Wed 45.000 over -> Thu and Fri 95.000", () => {
  const w = computeWeek(MON, [100 * K, 65 * K, 145 * K, 0, 0, 0, 0], 0, 0, 2);
  assert.deepEqual(w.budgets.slice(3), [95 * K, 95 * K, 300 * K, 300 * K]);
  assert.equal(w.pool, 0);
});

test("today's underspend is not saved money until the day ends", () => {
  assert.equal(computeWeek(MON, [50 * K, 0, 0, 0, 0, 0, 0], 0, 0, 0).pool, 0);
  assert.equal(computeWeek(MON, [50 * K, 0, 0, 0, 0, 0, 0], 0, 0, 1).pool, 50 * K);
});

test("a day never goes below 0; the rest spills to the weekend, then floating debt", () => {
  // Wed 1.050.000: over 950. Thu/Fri give 200, Sat/Sun give 600, 150 is debt.
  const w = computeWeek(MON, [100 * K, 100 * K, 1_050 * K, 0, 0, 0, 0], 0, 0, 2);
  assert.deepEqual(w.budgets.slice(3), [0, 0, 0, 0]);
  assert.equal(w.weekDebt, 150 * K);
});

test("Friday overspend goes to the weekend equally", () => {
  const w = computeWeek(MON, [100 * K, 100 * K, 100 * K, 100 * K, 200 * K, 0, 0], 0, 0, 4);
  assert.deepEqual(w.budgets.slice(5), [250 * K, 250 * K]);
});

test("uneven split keeps whole rupiah and loses nothing", () => {
  const w = computeWeek(MON, [200 * K + 1, 0, 0, 0, 0, 0, 0], 0, 0, 0);
  const cut = 4 * 100 * K - w.budgets.slice(1, 5).reduce((a, b) => a + b, 0);
  assert.equal(cut, 100 * K + 1);
  assert.ok(w.budgets.every(Number.isInteger));
});

test("Sunday close: saved money pays old debt first, the rest carries", () => {
  const w = computeWeek(MON, [50 * K, 100 * K, 100 * K, 100 * K, 100 * K, 300 * K, 300 * K], 0, 30 * K, 7);
  assert.equal(w.debtOut, 0);
  assert.equal(w.carryOut, 20 * K);
});

test("carry-in is extra this week, pays overspend first, and is not added to daily budgets", () => {
  const w = computeWeek(MON, [150 * K, 0, 0, 0, 0, 0, 0], 70 * K, 0, 0);
  assert.equal(w.budgets[1], 100 * K);
  assert.equal(w.pool, 20 * K);
});

test("ledger chains weeks: carry and debt move to the next week", () => {
  const entries = [
    { date: MON, amount: 50 * K, bill: false }, // saves 50 on Mon
    { date: addDays(MON, 6), amount: 300 * K, bill: false },
  ];
  const l = computeLedger(entries, MON, addDays(MON, 8)); // next Tuesday
  assert.equal(l.weeks.length, 2);
  // week 1: Mon saves 50, Tue-Fri 4 x 100, Sat 300, Sun 0 -> carry 750
  assert.equal(l.weeks[0].carryOut, 750 * K);
  assert.equal(l.current.carryIn, 750 * K);
  assert.equal(status(l).leftWeek, WEEK_BUDGET + 750 * K);
});

test("bills never count against the budget", () => {
  const entries = [
    { date: MON, amount: 1_500 * K, bill: true },
    { date: MON, amount: 50 * K, bill: false },
  ];
  const s = status(computeLedger(entries, MON, MON));
  assert.equal(s.spentToday, 50 * K);
  assert.equal(billsThisMonth(entries, MON), 1_500 * K);
});

test("refund lowers the day's spend", () => {
  const entries = [
    { date: MON, amount: 150 * K, bill: false },
    { date: MON, amount: -60 * K, bill: false },
  ];
  const s = status(computeLedger(entries, MON, MON));
  assert.equal(s.spentToday, 90 * K);
  assert.equal(s.overToday, 0);
});

test("coveredByExtra shows the part of today's overspend that saved money paid", () => {
  const entries = [
    { date: MON, amount: 75 * K, bill: false }, // saves 25
    { date: addDays(MON, 1), amount: 115 * K, bill: false }, // 15 over, all paid by extra
  ];
  const s = status(computeLedger(entries, MON, addDays(MON, 1)));
  assert.equal(s.overToday, 15 * K);
  assert.equal(s.coveredByExtra, 15 * K);
  assert.equal(s.tomorrowBudget, 100 * K);
  assert.equal(s.extra, 10 * K);
});

test("property: closed week result always equals the week budget + carry-in - spent (500 random weeks)", () => {
  let seed = 42;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  for (let n = 0; n < 500; n++) {
    const spent = Array.from({ length: 7 }, (_, i) => Math.floor(rnd() * (i < 5 ? 225 : 660)) * K);
    const carryIn = rnd() < 0.3 ? Math.floor(rnd() * 150) * K : 0;
    const w = computeWeek(MON, spent, carryIn, 0, 7);
    const total = spent.reduce((a, b) => a + b, 0);
    assert.equal(w.carryOut - w.debtOut, WEEK_BUDGET + carryIn - total, `week ${n}: ${spent}`);
    assert.ok(w.budgets.every((b) => b >= 0 && Number.isInteger(b)));
  }
});

test("configureBudgets sets other amounts, and the money still adds up", () => {
  configureBudgets(150 * K, 400 * K);
  try {
    const w = computeWeek(MON, [200 * K, 0, 0, 0, 0, 0, 0], 0, 0, 0);
    assert.deepEqual(w.budgets, [150_000, 137_500, 137_500, 137_500, 137_500, 400_000, 400_000]);
    assert.equal(WEEK_BUDGET, 1_550 * K);
    assert.throws(() => configureBudgets(-1, 0));
  } finally {
    configureBudgets(100 * K, 300 * K);
  }
});
