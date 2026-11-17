import { test } from "node:test";
import assert from "node:assert/strict";
import { computeLedger, status } from "../supabase/functions/_shared/engine.ts";
import { dayHeaderText, spendReply, statusText } from "../supabase/functions/_shared/format.ts";

const MON = "2026-11-16", TUE = "2026-11-17";
const st = (entries: { date: string; amount: number; bill?: boolean }[], today = TUE) =>
  status(computeLedger(entries.map((e) => ({ bill: false, ...e })), MON, today));

test("Option A, normal spend: bold left-today, note line, grey context line", () => {
  const s = st([{ date: MON, amount: 200_000 }, { date: TUE, amount: 50_000 }]);
  const r = spendReply(s, { amount: 50_000, note: "bakso", who: "Sam", date: TUE, bill: false }, 0);
  assert.equal(r, [
    ":white_check_mark: *150.000 left today*",
    "50.000 bakso · Sam",
    "_Spent today 50.000 · Week 1.750.000 left · Tomorrow 200.000_",
  ].join("\n"));
});

test("Option A, overspend partly paid by extra: says where the rest went", () => {
  const s = st([{ date: MON, amount: 165_000 }, { date: TUE, amount: 260_000 }]);
  const r = spendReply(s, { amount: 260_000, note: "makan", who: "Alex", date: TUE, bill: false }, 0);
  assert.equal(r, [
    ":warning: *Over today by 60.000*",
    "Extra paid 35.000 · 25.000 moved to Wed-Fri",
    "260.000 makan · Alex",
    "_Spent today 260.000 · Week 1.575.000 left · Tomorrow 191.667 (was 200.000)_",
  ].join("\n"));
});

test("Option A, bill: no budget lines", () => {
  const s = st([{ date: TUE, amount: 1_000_000, bill: true }]);
  const r = spendReply(s, { amount: 1_000_000, note: "carry over last week", who: "Alex", date: TUE, bill: true }, 1_000_000);
  assert.equal(r, [
    ":receipt: *Bill logged: 1.000.000*",
    "carry over last week · Alex",
    "_Not in the budget · Bills this month 1.000.000_",
  ].join("\n"));
});

test("bill with no note still reads well", () => {
  const s = st([]);
  const r = spendReply(s, { amount: 500_000, note: "", who: "Alex", date: TUE, bill: true }, 500_000);
  assert.match(r.split("\n")[1], /^bill · Alex$/);
});

test("backdated and corrected entries say so on the note line; channel hint goes last", () => {
  const s = st([{ date: MON, amount: 200_000 }]);
  const r = spendReply(s, { amount: 200_000, note: "", who: "Alex", date: MON, bill: false }, 0, { corrected: true, fromChannel: true });
  const lines = r.split("\n");
  assert.equal(lines[1], "200.000 · Alex · for Mon 16 Nov · corrected");
  assert.match(lines[lines.length - 1], /^_Logged from the channel/);
});

test("a week overspend shows 'over', not '0 left'", () => {
  const s = st([{ date: MON, amount: 2_100_000 }], MON);
  const r = spendReply(s, { amount: 2_100_000, note: "", who: "Alex", date: MON, bill: false }, 0);
  assert.match(r, /Week 100\.000 over/);
  assert.match(r, /100\.000 to floating debt/);
});

test("day header: one line with the date, today's budget and the week", () => {
  const h = dayHeaderText(st([{ date: MON, amount: 200_000 }]));
  assert.equal(h.split("\n")[0], "*Tue 17 Nov* · 200.000 to spend today · Week 1.800.000 left");
});

test("/spent week status keeps every number", () => {
  const t = statusText(st([{ date: MON, amount: 100_000 }, { date: TUE, amount: 50_000 }]), 1_000_000);
  assert.match(t, /150\.000 left today/);
  assert.match(t, /Spent today 50\.000 of 200\.000/);
  assert.match(t, /Extra this week 100\.000 · Bills this month 1\.000\.000/);
});
