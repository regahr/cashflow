import { test } from "node:test";
import assert from "node:assert/strict";
import { computeWeek, computeLedger, status, billsThisMonth, WEEK_BUDGET } from "../supabase/functions/_shared/engine.ts";
import { addDays } from "../supabase/functions/_shared/dates.ts";

const K = 1_000;
const MON = "2026-11-23"; // a Monday

test("round 1 example: Monday 260.000 -> Tue-Fri 185.000, left this week 1.740.000", () => {
  const w = computeWeek(MON, [260 * K, 0, 0, 0, 0, 0, 0], 0, 0, 0);
  assert.deepEqual(w.budgets, [200 * K, 185 * K, 185 * K, 185 * K, 185 * K, 500 * K, 500 * K]);
  const l = computeLedger([{ date: MON, amount: 260 * K, bill: false }], MON, MON);
  const s = status(l);
  assert.equal(s.leftWeek, 1_740 * K);
  assert.equal(s.overToday, 60 * K);
  assert.equal(s.tomorrowBudget, 185 * K);
});

test("round 2 example under rule 1a: week 2.150.000 ends with floating debt 150.000, carry 0", () => {
  const spent = [300, 100, 175, 175, 400, 600, 400].map((x) => x * K);
  const w = computeWeek(MON, spent, 0, 0, 7);
  // Mon over 100 -> Tue-Fri 175. Tue saves 75. Fri over 225, 75 paid by extra, 150 -> Sat/Sun 425.
  // Sat over 175 -> Sun 250. Sun over 150 -> debt.
  assert.deepEqual(w.budgets, [200, 175, 175, 175, 175, 425, 250].map((x) => x * K));
  assert.equal(w.weekDebt, 150 * K);
  assert.equal(w.debtOut, 150 * K);
  assert.equal(w.carryOut, 0);
});

test("gap 1a example: Tue saves 35.000, Wed 45.000 over -> Thu and Fri 195.000", () => {
  const w = computeWeek(MON, [200 * K, 165 * K, 245 * K, 0, 0, 0, 0], 0, 0, 2);
  assert.deepEqual(w.budgets.slice(3), [195 * K, 195 * K, 500 * K, 500 * K]);
  assert.equal(w.pool, 0);
});

test("today's underspend is not saved money until the day ends", () => {
  const w = computeWeek(MON, [50 * K, 0, 0, 0, 0, 0, 0], 0, 0, 0);
  assert.equal(w.pool, 0);
  const w2 = computeWeek(MON, [50 * K, 0, 0, 0, 0, 0, 0], 0, 0, 1);
  assert.equal(w2.pool, 150 * K);
});

test("a day never goes below 0; the rest spills to the weekend, then floating debt", () => {
  // Wed 1.650.000: over 1.450. Thu/Fri give 400, Sat/Sun give 1.000, 50 is debt.
  const w = computeWeek(MON, [200 * K, 200 * K, 1_650 * K, 0, 0, 0, 0], 0, 0, 2);
  assert.deepEqual(w.budgets.slice(3), [0, 0, 0, 0]);
  assert.equal(w.weekDebt, 50 * K);
  assert.ok(w.budgets.every((b) => b >= 0));
});

test("Friday overspend goes to the weekend equally", () => {
  const w = computeWeek(MON, [200 * K, 200 * K, 200 * K, 200 * K, 300 * K, 0, 0], 0, 0, 4);
  assert.deepEqual(w.budgets.slice(5), [450 * K, 450 * K]);
});

test("uneven split keeps whole rupiah and loses nothing", () => {
  const w = computeWeek(MON, [300 * K + 1, 0, 0, 0, 0, 0, 0], 0, 0, 0);
  const cut = 4 * 200 * K - w.budgets.slice(1, 5).reduce((a, b) => a + b, 0);
  assert.equal(cut, 100 * K + 1);
  assert.ok(w.budgets.every(Number.isInteger));
});

test("Sunday close: saved money pays old debt first, the rest carries", () => {
  const w = computeWeek(MON, [100 * K, 200 * K, 200 * K, 200 * K, 200 * K, 500 * K, 500 * K], 0, 30 * K, 7);
  assert.equal(w.debtOut, 0);
  assert.equal(w.carryOut, 70 * K);
});

test("carry-in is extra this week, pays overspend first, and is not added to daily budgets", () => {
  const w = computeWeek(MON, [250 * K, 0, 0, 0, 0, 0, 0], 70 * K, 0, 0);
  assert.equal(w.budgets[1], 200 * K);
  assert.equal(w.pool, 20 * K);
});

test("ledger chains weeks: carry and debt move to the next week", () => {
  const entries = [
    { date: MON, amount: 100 * K, bill: false }, // saves 100 on Mon
    { date: addDays(MON, 6), amount: 500 * K, bill: false },
  ];
  const l = computeLedger(entries, MON, addDays(MON, 8)); // next Tuesday
  assert.equal(l.weeks.length, 2);
  // week 1: Mon saved 100, Tue-Sat saved 200*4+500 = 1.300, Sun 0 -> carry 1.400
  assert.equal(l.weeks[0].carryOut, 1_400 * K);
  assert.equal(l.current.carryIn, 1_400 * K);
  assert.equal(status(l).leftWeek, WEEK_BUDGET + 1_400 * K);
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
    { date: MON, amount: 250 * K, bill: false },
    { date: MON, amount: -60 * K, bill: false },
  ];
  const s = status(computeLedger(entries, MON, MON));
  assert.equal(s.spentToday, 190 * K);
  assert.equal(s.overToday, 0);
});

test("coveredByExtra shows the part of today's overspend that saved money paid", () => {
  const entries = [
    { date: MON, amount: 150 * K, bill: false }, // saves 50
    { date: addDays(MON, 1), amount: 230 * K, bill: false }, // 30 over, all paid by extra
  ];
  const s = status(computeLedger(entries, MON, addDays(MON, 1)));
  assert.equal(s.overToday, 30 * K);
  assert.equal(s.coveredByExtra, 30 * K);
  assert.equal(s.tomorrowBudget, 200 * K);
  assert.equal(s.extra, 20 * K);
});

test("property: closed week result always equals 2.000.000 + carry-in - spent (500 random weeks)", () => {
  let seed = 42;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  for (let n = 0; n < 500; n++) {
    const spent = Array.from({ length: 7 }, (_, i) => Math.floor(rnd() * (i < 5 ? 450 : 1_100)) * K);
    const carryIn = rnd() < 0.3 ? Math.floor(rnd() * 300) * K : 0;
    const w = computeWeek(MON, spent, carryIn, 0, 7);
    const total = spent.reduce((a, b) => a + b, 0);
    assert.equal(w.carryOut - w.debtOut, WEEK_BUDGET + carryIn - total, `week ${n}: ${spent}`);
    assert.ok(w.budgets.every((b) => b >= 0 && Number.isInteger(b)));
  }
});
