// Turns spend entries into CSV reports: each day, each week, and so far.
//
//   node scripts/report.ts backup1.csv backup2.csv --out reports/
//       Reads the CSV files the bot posts every Monday (date,who,amount,note,bill).
//   node scripts/report.ts --example --out docs/example/
//       Runs a made-up week of chat messages through the real parser and engine.
//
// Uses the default budgets in engine.ts. Pass --weekday 150000 --weekend 400000 to use others.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { addDays, dayName, weekStart } from "../supabase/functions/_shared/dates.ts";
import { BASE_BUDGETS, computeLedger, configureBudgets, type Entry, status, WEEKDAY_BUDGET, WEEKEND_BUDGET } from "../supabase/functions/_shared/engine.ts";
import { parseSpend } from "../supabase/functions/_shared/parse.ts";

interface Row { date: string; who: string; amount: number; note: string; bill: boolean }

// A made-up week for two people, Alex and Sam, typed the way people type in the day thread.
const EXAMPLE: [string, string, string][] = [
  ["2026-11-23", "Sam", "35rb kopi"],
  ["2026-11-23", "Alex", "125k makan siang"],
  ["2026-11-24", "Alex", "25k makan 5k parkir"],
  ["2026-11-24", "Sam", "1,5jt listrik #bill"],
  ["2026-11-25", "Sam", "140rb belanja"],
  ["2026-11-26", "Alex", "kemarin 15k parkir"],
  ["2026-11-26", "Alex", "0"],
  ["2026-11-27", "Sam", "85rb bensin"],
  ["2026-11-27", "Alex", "-20rb refund payung"],
  ["2026-11-28", "Alex", "250rb jalan-jalan"],
  ["2026-11-28", "Sam", "120rb nonton"],
  ["2026-11-29", "Sam", "180rb makan keluarga"],
  ["2026-11-30", "Alex", "120rb makan"],
  ["2026-12-01", "Sam", "45k sarapan"],
];

function exampleRows(): Row[] {
  return EXAMPLE.flatMap(([day, who, text]) => {
    const p = parseSpend(text);
    if (p.kind !== "spend" || p.needsConfirm) throw new Error(`example line not understood: ${text}`);
    return [{ date: addDays(day, -p.daysBack), who, amount: p.amount, note: p.note, bill: p.bill }];
  });
}

function parseCsv(text: string): Row[] {
  const lines = text.trim().split(/\r?\n/).slice(1);
  return lines.filter(Boolean).map((line) => {
    const cells: string[] = [];
    let cur = "", quoted = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (quoted) {
        if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (c === '"') quoted = false;
        else cur += c;
      } else if (c === '"') quoted = true;
      else if (c === ",") { cells.push(cur); cur = ""; }
      else cur += c;
    }
    cells.push(cur);
    const [date, who, amount, note, bill] = cells;
    return { date, who, amount: Number(amount), note, bill: bill === "true" };
  });
}

const q = (s: string) => /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
const csv = (header: string[], rows: (string | number)[][]) =>
  [header.join(","), ...rows.map((r) => r.map((c) => q(String(c))).join(","))].join("\n") + "\n";

function reports(rows: Row[]) {
  rows.sort((a, b) => a.date.localeCompare(b.date));
  const first = weekStart(rows[0].date);
  const last = rows[rows.length - 1].date;
  const entries: Entry[] = rows.map((r) => ({ date: r.date, amount: r.amount, bill: r.bill }));

  const daily: (string | number)[][] = [];
  const soFar: (string | number)[][] = [];
  let spentSum = 0, planSum = 0;
  for (let d = first; d <= last; d = addDays(d, 1)) {
    const upTo = entries.filter((e) => e.date <= d);
    const s = status(computeLedger(upTo, first, d));
    const moved = s.movedTo.reduce((a, m) => a + m.amount, 0);
    const bills = entries.filter((e) => e.bill && e.date === d).reduce((a, e) => a + e.amount, 0);
    daily.push([d, dayName(d), s.todayBudget, s.spentToday, s.leftToday, s.overToday, s.coveredByExtra, moved, s.toDebt, bills]);
    spentSum += s.spentToday;
    planSum += BASE_BUDGETS[(new Date(d + "T00:00:00Z").getUTCDay() + 6) % 7];
    soFar.push([d, planSum, spentSum, planSum - spentSum]);
  }

  const ledger = computeLedger(entries, first, last);
  const weekly = ledger.weeks.map((w) => {
    const spent = w.spent.reduce((a, b) => a + b, 0);
    const end = addDays(w.weekStart, 6);
    const bills = entries.filter((e) => e.bill && e.date >= w.weekStart && e.date <= end).reduce((a, e) => a + e.amount, 0);
    const budget = BASE_BUDGETS.reduce((a, b) => a + b, 0);
    return [w.weekStart, w.closed ? "closed" : "open", budget, w.carryIn, spent, bills,
      w.closed ? w.carryOut : "", w.closed ? w.debtOut : w.debtIn + w.weekDebt];
  });

  return {
    "entries.csv": csv(["date", "who", "amount", "note", "bill"], rows.map((r) => [r.date, r.who, r.amount, r.note, String(r.bill)])),
    "daily.csv": csv(["date", "day", "budget", "spent", "left", "over", "paid_by_extra", "moved_to_later_days", "to_floating_debt", "bills"], daily),
    "weekly.csv": csv(["week_start", "state", "budget", "carry_in", "spent", "bills", "carry_out", "floating_debt"], weekly),
    "so-far.csv": csv(["date", "budget_so_far", "spent_so_far", "difference"], soFar),
  };
}

const args = process.argv.slice(2);
const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
const out = flag("--out") ?? "reports";
const wd = flag("--weekday"), we = flag("--weekend");
configureBudgets(Number(wd ?? WEEKDAY_BUDGET), Number(we ?? WEEKEND_BUDGET));
const example = args.includes("--example");
const files = args.filter((a) => a !== "--example");
const rows = example ? exampleRows() : files.flatMap((f) => parseCsv(readFileSync(f, "utf8")));
if (rows.length === 0) {
  console.error("No entries. Give the CSV files the bot posts, or --example.");
  process.exit(1);
}
mkdirSync(out, { recursive: true });
for (const [name, body] of Object.entries(reports(rows))) {
  writeFileSync(join(out, name), body);
  console.log(`wrote ${join(out, name)}`);
}
