// Cashflow bot: one Edge Function for Slack events, the /spent command and the cron jobs.
// Each day has one bot thread. A spend in that thread counts for that day.
// Plain code. No LLM.

import { createClient } from "npm:@supabase/supabase-js@2.49.1";
import { addDays, slackTsToWibDate, wibDate, weekStart } from "../_shared/dates.ts";
import { billsThisMonth, computeLedger, configureBudgets, status, type Entry, WEEKDAY_BUDGET, WEEKEND_BUDGET } from "../_shared/engine.ts";
import { dayHeaderText, type Logged, reminderInThread, removedReply, type ReplyOptions, spendReply, statusText, weekCloseText } from "../_shared/format.ts";
import { parseSpend, rupiah } from "../_shared/parse.ts";
import { Slack, verifySlack } from "../_shared/slack.ts";

const env = (k: string) => {
  const v = Deno.env.get(k);
  if (!v) throw new Error(`missing env ${k}`);
  return v;
};

const CHANNEL = env("CASHFLOW_CHANNEL_ID");
// Daily amounts in whole currency units. Leave unset to use the defaults in engine.ts.
configureBudgets(
  Number(Deno.env.get("CASHFLOW_WEEKDAY_BUDGET") ?? WEEKDAY_BUDGET),
  Number(Deno.env.get("CASHFLOW_WEEKEND_BUDGET") ?? WEEKEND_BUDGET),
);
const START_DATE = env("CASHFLOW_START_DATE"); // a Monday, "YYYY-MM-DD"
const NAMES = Object.fromEntries(
  (Deno.env.get("CASHFLOW_USER_NAMES") ?? "").split(",").filter(Boolean).map((p) => p.split("=")),
); // "U123=Alex,U456=Sam"

const db = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
const slack = new Slack(env("SLACK_BOT_TOKEN"), Deno.env.get("SLACK_API_BASE") ?? undefined); // base override is for the local test only

const who = (user: string) => NAMES[user] ?? `<@${user}>`;
const today = () => wibDate(Date.now());

// ---------- data ----------

async function loadEntries(): Promise<Entry[]> {
  const { data, error } = await db.from("entries")
    .select("spent_on, amount, bill")
    .is("deleted_at", null)
    .gte("spent_on", weekStart(START_DATE));
  if (error) throw error;
  return (data ?? []).map((r) => ({ date: r.spent_on, amount: Number(r.amount), bill: r.bill }));
}

async function currentReply(logged: Logged, opts: ReplyOptions = {}) {
  const entries = await loadEntries();
  const t = today();
  if (t < START_DATE) return `Logged ${rupiah(logged.amount)}. The budget starts on ${START_DATE}.`;
  return spendReply(status(computeLedger(entries, START_DATE, t)), logged, billsThisMonth(entries, t), opts);
}

async function removedText(amount: number, note: string, user: string) {
  const entries = await loadEntries();
  return removedReply(status(computeLedger(entries, START_DATE, today())), amount, note, who(user));
}

// ---------- day threads ----------

async function dayOfThread(threadTs: string): Promise<string | null> {
  const { data } = await db.from("day_threads").select("day").eq("ts", threadTs).maybeSingle();
  return data?.day ?? null;
}

/** Returns the ts of the day's thread. Posts it when it does not exist yet. */
async function ensureDayThread(day: string): Promise<string | undefined> {
  const { data: found } = await db.from("day_threads").select("ts").eq("day", day).maybeSingle();
  if (found) return found.ts;
  const entries = await loadEntries();
  const ts = await slack.post(CHANNEL, dayHeaderText(status(computeLedger(entries, START_DATE, day))));
  if (!ts) return undefined;
  const { error } = await db.from("day_threads").insert({ day, ts });
  if (error) { // another request posted it first: keep theirs
    await slack.call("chat.delete", { channel: CHANNEL, ts });
    const { data } = await db.from("day_threads").select("ts").eq("day", day).maybeSingle();
    return data?.ts;
  }
  return ts;
}

/** Which day a message counts for: its day thread, or (top level) the day it was sent. Null = not a log message. */
async function dayFor(ts: string, threadTs: string | undefined): Promise<string | null> {
  if (threadTs) return await dayOfThread(threadTs);
  return slackTsToWibDate(ts);
}

// ---------- message events ----------

async function onNewMessage(ev: { ts: string; user: string; text: string; channel: string; thread_ts?: string }) {
  const p = parseSpend(ev.text ?? "", { anywhere: !!ev.thread_ts });
  if (p.kind === "ignore") return;
  const day = await dayFor(ev.ts, ev.thread_ts);
  if (!day) return; // a thread that is not a day thread (for example a planning thread)
  if (day < START_DATE) return;
  const replyIn = ev.thread_ts ?? await ensureDayThread(slackTsToWibDate(ev.ts));
  if (p.needsConfirm) {
    await slack.post(ev.channel, `Did you mean ${rupiah(p.amount * 1000)}? Edit your message to fix it. I did not log it.`, replyIn);
    return;
  }
  const date = addDays(day, -p.daysBack);
  const { data, error } = await db.from("entries").insert({
    source_key: ev.ts, channel: ev.channel, user_id: ev.user, spent_on: date,
    amount: p.amount, note: p.note, bill: p.bill,
  }).select("id").maybeSingle();
  if (error?.code === "23505") return; // already logged (Slack retry)
  if (error) throw error;

  await slack.react(ev.channel, ev.ts, "white_check_mark");
  const text = await currentReply({ amount: p.amount, note: p.note, who: who(ev.user), date, bill: p.bill }, { fromChannel: !ev.thread_ts });
  const replyTs = await slack.post(ev.channel, text, replyIn);
  if (replyTs && data) await db.from("entries").update({ reply_ts: replyTs }).eq("id", data.id);
}

async function onEdited(ev: { channel: string; message: { ts: string; user: string; text: string; thread_ts?: string } }) {
  const m = ev.message;
  const p = parseSpend(m.text ?? "", { anywhere: !!m.thread_ts });
  const { data: row } = await db.from("entries").select("id, reply_ts, deleted_at, spent_on, amount, note, bill, user_id")
    .eq("source_key", m.ts).maybeSingle();

  if (p.kind === "ignore" || p.needsConfirm) {
    if (!row || row.deleted_at) return;
    await db.from("entries").update({ deleted_at: new Date().toISOString() }).eq("id", row.id);
    if (row.reply_ts) await slack.update(ev.channel, row.reply_ts, await removedText(Number(row.amount), row.note, row.user_id));
    return;
  }
  if (!row) return onNewMessage({ ts: m.ts, user: m.user, text: m.text, channel: ev.channel, thread_ts: m.thread_ts }); // was chat, now a spend

  const day = await dayFor(m.ts, m.thread_ts);
  if (!day) return;
  const date = addDays(day, -p.daysBack);
  const same = !row.deleted_at && row.spent_on === date && Number(row.amount) === p.amount && row.note === p.note && row.bill === p.bill;
  if (same) return; // e.g. Slack marks the parent "changed" when a thread reply is added
  await db.from("entries").update({
    spent_on: date, amount: p.amount, note: p.note, bill: p.bill, deleted_at: null, updated_at: new Date().toISOString(),
  }).eq("id", row.id);
  const text = await currentReply({ amount: p.amount, note: p.note, who: who(m.user), date, bill: p.bill }, { corrected: true });
  if (row.reply_ts) await slack.update(ev.channel, row.reply_ts, text);
  else await slack.post(ev.channel, text, m.thread_ts ?? m.ts);
}

async function onDeleted(ev: { channel: string; deleted_ts: string }) {
  const { data: row } = await db.from("entries").select("id, reply_ts, amount, note, user_id")
    .eq("source_key", ev.deleted_ts).is("deleted_at", null).maybeSingle();
  if (!row) return;
  await db.from("entries").update({ deleted_at: new Date().toISOString() }).eq("id", row.id);
  if (row.reply_ts) await slack.update(ev.channel, row.reply_ts, await removedText(Number(row.amount), row.note, row.user_id));
}

// ---------- /spent ----------

async function onCommand(f: URLSearchParams) {
  const user = f.get("user_id")!;
  const text = (f.get("text") ?? "").trim();
  const thread = await ensureDayThread(today()); // every /spent answer goes in today's thread

  if (/^undo$/i.test(text)) {
    const { data: row } = await db.from("entries").select("id, amount, note")
      .eq("user_id", user).eq("channel", CHANNEL).is("deleted_at", null)
      .order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (!row) return slack.post(CHANNEL, `${who(user)}: nothing to undo.`, thread);
    await db.from("entries").update({ deleted_at: new Date().toISOString() }).eq("id", row.id);
    return slack.post(CHANNEL, `Undone: ${rupiah(Number(row.amount))} ${row.note} (${who(user)})`.trim(), thread);
  }

  if (/^(week|minggu)?$/i.test(text)) {
    const entries = await loadEntries();
    const s = status(computeLedger(entries, START_DATE, today()));
    return slack.post(CHANNEL, statusText(s, billsThisMonth(entries, s.today)), thread);
  }

  const p = parseSpend(text);
  if (p.kind === "ignore" || p.needsConfirm) {
    return slack.post(CHANNEL, `${who(user)}: I could not read "${text}". Try "/spent 50rb bakso".`, thread);
  }
  const date = addDays(today(), -p.daysBack);
  const { error } = await db.from("entries").insert({
    source_key: `cmd:${f.get("trigger_id")}`, channel: CHANNEL, user_id: user, spent_on: date,
    amount: p.amount, note: p.note, bill: p.bill,
  });
  if (error?.code === "23505") return;
  if (error) throw error;
  await slack.post(CHANNEL, await currentReply({ amount: p.amount, note: p.note, who: who(user), date, bill: p.bill }), thread);
}

// ---------- cron ----------

async function once(kind: string, day: string): Promise<boolean> {
  const { error } = await db.from("job_runs").insert({ kind, run_on: day });
  return !error; // a duplicate key means it already ran today
}

async function reminder() {
  const t = today();
  if (t < START_DATE) return;
  const { count } = await db.from("entries").select("id", { count: "exact", head: true })
    .eq("spent_on", t).eq("bill", false).is("deleted_at", null);
  if ((count ?? 0) > 0) return; // somebody already logged today (a #bill does not count)
  if (!(await once("reminder", t))) return;
  const thread = await ensureDayThread(t);
  if (!thread) return;
  // reply_broadcast: the reminder also shows in the channel, so both of you get it.
  await slack.call("chat.postMessage", { channel: CHANNEL, thread_ts: thread, reply_broadcast: true, text: reminderInThread(t) });
}

/**
 * One-off: redraw the bot's own messages for a day in the current layout.
 * Each reply shows the numbers as they were right after that entry. The day header shows the numbers now.
 */
async function rerenderDay(day: string) {
  const { data, error } = await db.from("entries")
    .select("id, user_id, spent_on, amount, note, bill, reply_ts, created_at")
    .is("deleted_at", null).gte("spent_on", weekStart(START_DATE)).order("created_at");
  if (error) throw error;
  const rows = data ?? [];
  const asEntry = (r: typeof rows[number]): Entry => ({ date: r.spent_on, amount: Number(r.amount), bill: r.bill });
  for (const r of rows) {
    if (!r.reply_ts || wibDate(Date.parse(r.created_at)) !== day) continue;
    const upTo = rows.filter((x) => x.created_at <= r.created_at).map(asEntry);
    const s = status(computeLedger(upTo, START_DATE, day));
    const text = spendReply(s, { amount: Number(r.amount), note: r.note, who: who(r.user_id), date: r.spent_on, bill: r.bill },
      billsThisMonth(upTo, day));
    await slack.update(CHANNEL, r.reply_ts, text);
  }
  const { data: head } = await db.from("day_threads").select("ts").eq("day", day).maybeSingle();
  if (head) await slack.update(CHANNEL, head.ts, dayHeaderText(status(computeLedger(rows.map(asEntry), START_DATE, day))));
}

/** 00:05 WIB each day: on Monday close last week, then post the new day's thread. */
async function dayJob() {
  const t = today();
  if (t < START_DATE) return;
  await weekClose();
  await ensureDayThread(t);
}

async function weekClose() {
  const t = today(); // runs at 00:05 WIB; only Monday has a closed week before it
  const entries = await loadEntries();
  const ledger = computeLedger(entries, START_DATE, t);
  const closed = ledger.weeks.at(-2);
  if (!closed || !closed.closed || closed.weekStart !== weekStart(addDays(t, -7))) return;
  if (!(await once("close", t))) return;
  await slack.post(CHANNEL, weekCloseText(closed));

  const { data } = await db.from("entries").select("spent_on, user_id, amount, note, bill")
    .is("deleted_at", null).gte("spent_on", closed.weekStart).lte("spent_on", addDays(closed.weekStart, 6))
    .order("spent_on");
  const csv = ["date,who,amount,note,bill",
    ...(data ?? []).map((r) => [r.spent_on, who(r.user_id), r.amount, `"${String(r.note).replace(/"/g, '""')}"`, r.bill].join(","))]
    .join("\n");
  await slack.uploadText(CHANNEL, `cashflow-${closed.weekStart}.csv`, csv, "Backup of last week.");
}

// ---------- router ----------

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const job = url.searchParams.get("job");
  if (job) {
    if (req.headers.get("x-cron-secret") !== env("CRON_SECRET")) return new Response("forbidden", { status: 403 });
    if (job === "reminder") await reminder();
    else if (job === "day") await dayJob();
    else if (job === "close") await weekClose();
    else if (job === "rerender") {
      const day = url.searchParams.get("day") ?? today();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return new Response("bad day", { status: 400 });
      await rerenderDay(day);
    }
    return new Response("ok");
  }

  const body = await req.text();
  if (!(await verifySlack(req, body, env("SLACK_SIGNING_SECRET")))) return new Response("bad signature", { status: 401 });
  if (req.headers.get("x-slack-retry-num")) return new Response("ok"); // first delivery is already handled

  const work = (p: Promise<unknown>) => {
    // Answer Slack at once (3 s limit); finish the work in the background.
    // @ts-ignore EdgeRuntime is a Supabase global
    EdgeRuntime.waitUntil(p.catch((e) => console.error(e)));
  };

  if ((req.headers.get("content-type") ?? "").includes("application/x-www-form-urlencoded")) {
    const f = new URLSearchParams(body);
    if (f.get("channel_id") !== CHANNEL) {
      return Response.json({ response_type: "ephemeral", text: "Use /spent in the cashflow channel." });
    }
    work(onCommand(f));
    return new Response("", { status: 200 });
  }

  const payload = JSON.parse(body);
  if (payload.type === "url_verification") return Response.json({ challenge: payload.challenge });

  const ev = payload.event;
  if (payload.type === "event_callback" && ev?.type === "message" && ev.channel === CHANNEL) {
    if (ev.bot_id || ev.subtype === "bot_message") return new Response("ok");
    if (!ev.subtype || ev.subtype === "thread_broadcast") work(onNewMessage(ev));
    else if (ev.subtype === "message_changed" && ev.message?.edited && !ev.message?.bot_id) work(onEdited(ev));
    else if (ev.subtype === "message_deleted") work(onDeleted(ev));
  }
  return new Response("ok");
});
