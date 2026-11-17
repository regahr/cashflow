// Turns a chat line into a spend. Plain rules, no LLM.
//
// A line is a spend only when it starts with an amount, optionally after "kemarin" / "yesterday".
//   "50rb bakso"            -> 50.000
//   "25k makan 5k parkir"   -> 30.000 (every amount with a suffix or >= 1.000 adds up)
//   "1,5jt listrik #bill"   -> 1.500.000, bill (outside the budget)
//   "kemarin 50.000 bensin" -> 50.000 on yesterday
//   "sarapan senin 30rb"    -> 30.000 on Monday of this week (a day name anywhere in the line)
//   "-20rb refund"          -> -20.000
//   "0"                     -> 0, closes the day
//   "50 bakso"              -> 50, needs a confirm ("did you mean 50.000?")

export type Parsed =
  | { kind: "spend"; amount: number; note: string; bill: boolean; daysBack: number; weekday: number | null; needsConfirm: boolean }
  | { kind: "ignore" };

const SUFFIX: Record<string, number> = { k: 1_000, rb: 1_000, ribu: 1_000, jt: 1_000_000, juta: 1_000_000 };
const AMOUNT = /(^|\s)(-?)(\d+(?:[.,]\d+)*)\s?(k|rb|ribu|jt|juta)?(?=$|\s|[^\p{L}\p{N}])/giu;
// Monday = 0 ... Sunday = 6. A day name counts only for this week, and only when one day is named.
const WEEKDAYS: [RegExp, number][] = [
  [/^(senin|monday)$/i, 0], [/^(selasa|tuesday)$/i, 1], [/^(rabu|wednesday)$/i, 2], [/^(kamis|thursday)$/i, 3],
  [/^(jumat|jum'at|friday)$/i, 4], [/^(sabtu|saturday)$/i, 5], [/^(minggu|sunday)$/i, 6],
];

function namedWeekday(text: string): number | null {
  const found = new Set<number>();
  for (const word of text.split(/[^\p{L}']+/u)) {
    for (const [re, i] of WEEKDAYS) if (re.test(word)) found.add(i);
  }
  return found.size === 1 ? [...found][0] : null;
}

const GROUPED = /^\d{1,3}([.,]\d{3})+$/;
const DECIMAL = /^\d+[.,]\d{1,2}$/;

interface Token { value: number; hasSuffix: boolean; grouped: boolean; start: number; end: number }

function toValue(num: string, suffix: string | undefined): number | null {
  if (suffix) {
    const mult = SUFFIX[suffix.toLowerCase()];
    if (DECIMAL.test(num)) return Math.round(parseFloat(num.replace(",", ".")) * mult);
    return parseInt(num.replace(/[.,]/g, ""), 10) * mult;
  }
  if (GROUPED.test(num)) return parseInt(num.replace(/[.,]/g, ""), 10);
  if (/^\d+$/.test(num)) return parseInt(num, 10);
  return null; // "50,5" with no suffix is not clear
}

function tokens(text: string): Token[] {
  const out: Token[] = [];
  for (const m of text.matchAll(AMOUNT)) {
    const [, lead, sign, num, suffix] = m;
    const v = toValue(num, suffix);
    if (v === null) continue;
    const start = m.index! + lead.length;
    out.push({
      value: sign ? -v : v,
      hasSuffix: !!suffix,
      grouped: GROUPED.test(num),
      start,
      end: m.index! + m[0].length,
    });
  }
  return out;
}

export interface ParseOptions {
  /** In a day thread the amount may be anywhere in the line ("beli kue2 20rb"), if it has rb/k/jt or looks like 20.000. */
  anywhere?: boolean;
}

export function parseSpend(raw: string, opts: ParseOptions = {}): Parsed {
  let text = raw.replace(/[*_~`]/g, "").trim();
  let daysBack = 0;
  const back = text.match(/^(kemarin|yesterday)\b[\s,:]*/i);
  if (back) {
    daysBack = 1;
    text = text.slice(back[0].length);
  }

  const toks = tokens(text);
  const clear = (t: Token) => t.hasSuffix || t.grouped || Math.abs(t.value) >= 1_000;
  let counted: Token[];
  let first: Token;
  if (toks.length > 0 && toks[0].start === 0) {
    first = toks[0];
    counted = [first, ...toks.slice(1).filter(clear)];
  } else if (opts.anywhere && toks.some(clear)) {
    counted = toks.filter(clear);
    first = counted[0];
  } else {
    return { kind: "ignore" };
  }
  const amount = counted.reduce((a, t) => a + t.value, 0);

  let note = text;
  for (const t of [...counted].sort((a, b) => b.start - a.start)) {
    note = note.slice(0, t.start) + " " + note.slice(t.end);
  }
  const bill = /#bill\b/i.test(note);
  note = note.replace(/#bill\b/gi, " ").replace(/\s+/g, " ").trim();

  const needsConfirm = !first.hasSuffix && !first.grouped && first.value !== 0 && Math.abs(first.value) < 1_000;
  const weekday = daysBack ? null : namedWeekday(note);
  return { kind: "spend", amount, note, bill, daysBack, weekday, needsConfirm };
}

export type Spend = Extract<Parsed, { kind: "spend" }>;

/**
 * A whole Slack message. When 2 or more lines are spends, each of those lines is its own entry,
 * with its own day name ("Indomaret senin 13rb" newline "Sarapan selasa 30rb"). Lines with no amount are left out.
 * Otherwise the message is one entry, as before.
 */
export function parseMessage(raw: string, opts: ParseOptions = {}): Spend[] {
  const lines = raw.split(/\r?\n/).map((l) => parseSpend(l, opts)).filter((p): p is Spend => p.kind === "spend");
  if (lines.length >= 2) return lines;
  const one = parseSpend(raw, opts);
  return one.kind === "spend" ? [one] : [];
}

/** "1740000" -> "1.740.000" */
export function rupiah(n: number): string {
  const s = Math.abs(Math.round(n)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return n < 0 ? "-" + s : s;
}
