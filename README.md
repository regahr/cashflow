# cashflow

A Slack bot for our household budget. We reply "50rb bakso" in today's thread, and it tells us what is left.

No app, no AI, no server. One Supabase function, about 800 lines of TypeScript, and it runs on the free tier.

<img src="docs/thread.png" alt="A day thread in Slack: two spends, an overspend and a bill, each with the bot's reply" width="560">

The amounts in this README and in the picture are examples. Set your own; see [Make it yours](#make-it-yours).

## How we log

Every night at 00:05 the bot opens a thread for the new day. We reply in it, from our phones:

```
50rb bakso                 50.000
25k makan 5k parkir        30.000, both amounts add up
1,5jt listrik #bill        1.500.000, kept outside the daily budget
kemarin 40rb bensin        logged on yesterday
-20rb refund               takes 20.000 off
0                          nothing spent today
```

The bot puts a check mark on the message and answers. The first line, in bold, is how much is left today. Under it, in grey, is what we spent today, what is left this week and tomorrow's budget.

Made a typo? Edit the message and the reply updates. Delete it and the entry goes away. At 20:00 the bot reminds us if nobody has logged anything that day. On Monday at 00:05 it closes the week and posts a CSV of every entry, as a backup.

## The rules

Out of the box, the budget is 200.000 rupiah on a weekday and 500.000 on Saturday and Sunday, so 2.000.000 a week.

If a day goes over, money we saved earlier in the week pays first. Whatever is left gets split evenly over the weekdays still to come, and no day goes below zero. If the weekdays are used up, the weekend takes it. If the weekend is used up too, it becomes "floating debt".

On Sunday night, any money left pays off the floating debt first. The rest carries over to next week as extra.

Bills tagged `#bill` (electricity, school, rent) are stored, but they never count against the daily budget. They show up as a monthly total.

## How it is built

- One Supabase Edge Function (Deno, TypeScript) receives Slack events and the `/spent` command.
- Postgres keeps one row per entry. Nothing else is stored: every number is replayed from those rows each time, so fixing an entry from three days ago just works.
- pg_cron calls the same function at 00:05 and 20:00.
- Slack is called with plain `fetch`. The only package is `supabase-js`.
- 43 unit tests, including 500 random weeks that check the money always adds up: what is left at the end equals 2.000.000 plus carry-over minus what we spent.

The budget logic is in [`engine.ts`](supabase/functions/_shared/engine.ts) (about 200 lines) and the input parsing is in [`parse.ts`](supabase/functions/_shared/parse.ts) (about 80).

## What it does not do

We built it for the two of us, in Indonesia. So:

- Rupiah only, Jakarta time (WIB) only.
- It understands the shorthand we use: `rb`, `ribu`, `k`, `jt`, `juta`, and `kemarin` or `yesterday`. Nothing else.
- The budget amounts are constants in the code. To change them, you edit one file (see below).
- One channel, and you type every spend yourself. No bank sync, no charts.
- Supabase pauses free projects after a week with no activity. Daily use keeps it awake.

## Set it up

You need the Supabase CLI and a Slack workspace where you can add apps. It takes about 20 minutes.

1. Create a Supabase project. Then, in this folder:

   ```
   supabase link --project-ref <your-project-ref>
   supabase db push
   ```

2. In the Supabase SQL editor, store 2 values that the cron jobs read. Pick any long random string as the cron secret (`openssl rand -hex 32` works):

   ```sql
   select vault.create_secret('https://<your-project-ref>.supabase.co', 'project_url');
   select vault.create_secret('<cron secret>', 'cron_secret');
   ```

3. Deploy the function:

   ```
   supabase functions deploy slack --no-verify-jwt
   ```

4. Create the Slack app at api.slack.com/apps: "Create New App", then "From a manifest", and paste [`slack-manifest.yaml`](slack-manifest.yaml) with your project ref filled in. Install it, then invite the bot to your channel with `/invite @cashflow`.

5. Add 6 secrets in Supabase (Edge Functions, then Secrets):

   | Name | Value |
   |---|---|
   | `SLACK_BOT_TOKEN` | the `xoxb-` token from "OAuth & Permissions" |
   | `SLACK_SIGNING_SECRET` | from "Basic Information" |
   | `CRON_SECRET` | the same string as in step 2 |
   | `CASHFLOW_CHANNEL_ID` | your channel's ID |
   | `CASHFLOW_START_DATE` | the Monday you start, like `2026-11-16` |
   | `CASHFLOW_USER_NAMES` | Slack member IDs and names, like `U0123ABC=Alex,U0456DEF=Sam` |

6. Back in the Slack app, open "Event Subscriptions" and click "Retry" next to the request URL. It should say "Verified". Post `10rb test` in the channel to check: the bot opens today's thread and answers there.

## Make it yours

Everything you might want to change is in a few short files. Change them before you deploy, or deploy again after.

| What | Where |
|---|---|
| Daily amounts | `WEEKDAY_BUDGET` and `WEEKEND_BUDGET` in [`engine.ts`](supabase/functions/_shared/engine.ts#L15-L16). The week total follows from them. |
| Timezone | `WIB_OFFSET_MS` in [`dates.ts`](supabase/functions/_shared/dates.ts#L3) (UTC+7 now). Change the cron times too, below. |
| When the day thread opens and when the reminder comes | The `cron.schedule` lines in [`day_threads.sql`](supabase/migrations/20261117100000_day_threads.sql#L14) (`5 17 * * *`, which is 00:05 in Jakarta) and [`init.sql`](supabase/migrations/20261117000000_init.sql#L35) (`0 13 * * *`, 20:00 in Jakarta). They are in UTC. Edit them before your first `supabase db push`. On a project that is already set up, add a new migration that calls `cron.unschedule` and `cron.schedule` again. |
| Money words | `SUFFIX` in [`parse.ts`](supabase/functions/_shared/parse.ts#L16) (`rb`, `k`, `jt`...) and the "yesterday" words on [line 55](supabase/functions/_shared/parse.ts#L55). |
| How numbers look | `rupiah()` in [`parse.ts`](supabase/functions/_shared/parse.ts#L80). It writes `1.750.000`. |
| What the bot says | `spendReply`, `dayHeaderText` and `reminderInThread` in [`format.ts`](supabase/functions/_shared/format.ts). |
| Who is who, the channel, the first Monday | The secrets in step 5. No code change. |

After a code change, run `npm test`, then `supabase functions deploy slack --no-verify-jwt`.

## Tests

```
npm test
```

Needs Node 22.18 or newer (we use 24). No install step: there are no npm dependencies.

## License

MIT
