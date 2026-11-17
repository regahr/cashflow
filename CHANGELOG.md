# Changelog

Each version is a git tag. The newest is at the top.

## 0.5.0 (2026-11-17)

- A message with 2 or more spend lines makes one entry for each line. Each line can name its own day, so a list like `indomaret senin 13rb` / `sarapan selasa 30rb` puts each spend on the right day.
- One reply for the whole message: one line for each spend, then the count, the total and who.
- Edit the message and all its entries update. Delete it and all of them are removed.
- A message with one spend line and some plain lines is still one entry, as before.

## 0.4.0 (2026-11-17)

- A day name puts a spend on that day of this week: `sarapan senin 30rb` counts for Monday. Indonesian and English names work, anywhere in the line.
- A day name never moves a spend to a later day, or to before the start date.
- A message that names 2 different days stays on the thread's day. `kemarin` wins over a day name.

## 0.3.0 (2026-11-17)

- In a day thread, the amount can be anywhere in the line: `beli kue2 20rb` works.
- When a spend is deleted, the reply says what was removed and shows the new totals.
- A demo GIF in the README.

## 0.2.0 (2026-11-17)

- The weekday and weekend amounts are settings (`CASHFLOW_WEEKDAY_BUDGET`, `CASHFLOW_WEEKEND_BUDGET`). No code change needed.
- `npm run report` makes daily, weekly and running-total CSVs from the Monday backups.
- An example week with reports in `docs/example/`.

## 0.1.0 (2026-11-17)

- First version: one thread per day, spends as replies, an answer with what is left today.
- Overspend is paid by money saved earlier in the week, then moves to the days left, then to floating debt.
- `#bill` entries stay outside the budget. Edit or delete a message to fix an entry.
- A 20:00 reminder, a Monday week close with a CSV backup, and the `/spent` command.
