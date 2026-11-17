import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSpend, rupiah } from "../supabase/functions/_shared/parse.ts";

function spend(text: string) {
  const p = parseSpend(text);
  assert.equal(p.kind, "spend", text);
  return p as Extract<typeof p, { kind: "spend" }>;
}

const cases: [string, number, string][] = [
  ["50rb bakso", 50_000, "bakso"],
  ["50k bakso", 50_000, "bakso"],
  ["50K Bakso", 50_000, "Bakso"],
  ["50.000 bakso", 50_000, "bakso"],
  ["50,000 bakso", 50_000, "bakso"],
  ["50000 bakso", 50_000, "bakso"],
  ["50 ribu bakso", 50_000, "bakso"],
  ["1,5jt listrik", 1_500_000, "listrik"],
  ["1.5jt listrik", 1_500_000, "listrik"],
  ["1.500.000 sekolah", 1_500_000, "sekolah"],
  ["2 juta", 2_000_000, ""],
  ["25k makan 5k parkir", 30_000, "makan parkir"],
  ["50rb bakso 2 porsi", 50_000, "bakso 2 porsi"],
  ["-20rb refund", -20_000, "refund"],
  ["0", 0, ""],
  ["*35rb* kopi", 35_000, "kopi"],
];

for (const [text, amount, note] of cases) {
  test(`parses "${text}"`, () => {
    const p = spend(text);
    assert.equal(p.amount, amount);
    assert.equal(p.note, note);
    assert.equal(p.needsConfirm, false);
  });
}

test("kemarin / yesterday backdates one day", () => {
  assert.equal(spend("kemarin 50.000 bensin").daysBack, 1);
  assert.equal(spend("Yesterday, 20k parkir").daysBack, 1);
  assert.equal(spend("50k bensin").daysBack, 0);
});

test("#bill marks a bill and leaves the note clean", () => {
  const p = spend("1,5jt listrik #bill");
  assert.equal(p.bill, true);
  assert.equal(p.note, "listrik");
  assert.equal(p.amount, 1_500_000);
});

test("a small bare number asks for a confirm", () => {
  assert.equal(spend("50 bakso").needsConfirm, true);
});

test("chat that does not start with an amount is ignored", () => {
  for (const t of ["makan siang tadi enak", "we have 2 kids", "ok", "", "bakso 50rb"]) {
    assert.equal(parseSpend(t).kind, "ignore", t);
  }
});

test("rupiah formats with dots", () => {
  assert.equal(rupiah(1_740_000), "1.740.000");
  assert.equal(rupiah(0), "0");
  assert.equal(rupiah(-20_000), "-20.000");
});

test("in a day thread the amount can be anywhere, if it is clearly an amount", () => {
  const p = parseSpend("beli kue2 20rb", { anywhere: true });
  assert.equal(p.kind, "spend");
  if (p.kind !== "spend") return;
  assert.equal(p.amount, 20_000);
  assert.equal(p.note, "beli kue2");
  assert.equal(p.needsConfirm, false);
  const q = parseSpend("makan 25k parkir 5k", { anywhere: true });
  assert.equal(q.kind === "spend" && q.amount, 30_000);
  const r = parseSpend("bayar listrik 1.500.000 #bill", { anywhere: true });
  assert.equal(r.kind === "spend" && r.amount, 1_500_000);
  assert.equal(r.kind === "spend" && r.bill, true);
});

test("anywhere mode still ignores lines with no clear amount", () => {
  for (const t of ["beli kue2", "beli 2 bakso", "ok sayang", "jam 5 ya"]) {
    assert.equal(parseSpend(t, { anywhere: true }).kind, "ignore", t);
  }
});

test("at the top level the amount must still come first", () => {
  assert.equal(parseSpend("beli kue2 20rb").kind, "ignore");
});
