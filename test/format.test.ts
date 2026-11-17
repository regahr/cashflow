import { test } from "node:test";
import assert from "node:assert/strict";
import { computeLedger, status } from "../supabase/functions/_shared/engine.ts";
import { dayHeaderText, spendReply, statusText } from "../supabase/functions/_shared/format.ts";

// Default budgets: 100.000 a weekday, 300.000 a weekend day.
const MON = "2026-11-16", TUE = "2026-11-17";
const st = (entries: { date: string; amount: number; bill?: boolean }[], today = TUE) =>
  status(computeLedger(entries.map((e) => ({ bill: false, ...e })), MON, today));

test("normal spend: bold left-today, note line, grey context line", () => {
  const s = st([{ date: MON, amount: 100_000 }, { date: TUE, amount: 25_000 }]);
  const r = spendReply(s, { amount: 25_000, note: "bakso", who: "Sam", date: TUE, bill: false }, 0);
  assert.equal(r, [
    ":white_check_mark: *75.000 left today*",
    "25.000 bakso · Sam",
    "_Spent today 25.000 · Week 975.000 left · Tomorrow 100.000_",
  ].join("\n"));
});

test("overspend partly paid by extra: says where the rest went", () => {
  const s = st([{ date: MON, amount: 65_000 }, { date: TUE, amount: 160_000 }]);
  const r = spendReply(s, { amount: 160_000, note: "makan", who: "Alex", date: TUE, bill: false }, 0);
  assert.equal(r, [
    ":warning: *Over today by 60.000*",
    "Extra paid 35.000 · 25.000 moved to Wed-Fri",
    "160.000 makan · Alex",
    "_Spent today 160.000 · Week 875.000 left · Tomorrow 91.667 (was 100.000)_",
  ].join("\n"));
});

test("bill: no budget lines", () => {
  const s = st([{ date: TUE, amount: 1_000_000, bill: true }]);
  const r = spendReply(s, { amount: 1_000_000, note: "listrik", who: "Alex", date: TUE, bill: true }, 1_000_000);
  assert.equal(r, [
    ":receipt: *Bill logged: 1.000.000*",
    "listrik · Alex",
    "_Not in the budget · Bills this month 1.000.000_",
  ].join("\n"));
});

test("bill with no note still reads well", () => {
  const r = spendReply(st([]), { amount: 500_000, note: "", who: "Alex", date: TUE, bill: true }, 500_000);
  assert.match(r.split("\n")[1], /^bill · Alex$/);
});

test("backdated and corrected entries say so on the note line; channel hint goes last", () => {
  const s = st([{ date: MON, amount: 100_000 }]);
  const r = spendReply(s, { amount: 100_000, note: "", who: "Alex", date: MON, bill: false }, 0, { corrected: true, fromChannel: true });
  const lines = r.split("\n");
  assert.equal(lines[1], "100.000 · Alex · for Mon 16 Nov · corrected");
  assert.match(lines[lines.length - 1], /^_Logged from the channel/);
});

test("a week overspend shows 'over', not '0 left'", () => {
  const s = st([{ date: MON, amount: 1_200_000 }], MON);
  const r = spendReply(s, { amount: 1_200_000, note: "", who: "Alex", date: MON, bill: false }, 0);
  assert.match(r, /Week 100\.000 over/);
  assert.match(r, /100\.000 to floating debt/);
});

test("day header: one line with the date, today's budget and the week", () => {
  const h = dayHeaderText(st([{ date: MON, amount: 100_000 }]));
  assert.equal(h.split("\n")[0], "*Tue 17 Nov* · 100.000 to spend today · Week 1.000.000 left");
});

test("/spent week status keeps every number", () => {
  const t = statusText(st([{ date: MON, amount: 50_000 }, { date: TUE, amount: 25_000 }]), 1_000_000);
  assert.match(t, /75\.000 left today/);
  assert.match(t, /Spent today 25\.000 of 100\.000/);
  assert.match(t, /Extra this week 50\.000 · Bills this month 1\.000\.000/);
});
