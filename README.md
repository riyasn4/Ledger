# Ledger — your personal finance app

This is a small, no-nonsense web app that does what your Excel sheet did —
track expenses, budget, debts/EMIs, friend & family lending, recurring
bills, and investments — but as an app you can open on your phone or
laptop, install like a real app, and scroll through easily.

Your old data (accounts, ~105 transactions, debts, budget categories,
lending, recurring bills, investments) is already loaded in as a starting
point. Everything from here on is stored **on the device you're using**
(in the browser's local storage) — there is no server and no login.

## 1. Try it right now

Just double-click `index.html` to open it in your browser. Everything
works immediately — no install needed.

## 2. Put it on your phone and laptop (GitHub Pages)

Since you've done this before with Hero's Journey, this will feel familiar:

1. Create a new GitHub repo (e.g. `ledger-app`).
2. Upload every file in this folder, keeping the `icons/` folder as a
   subfolder.
3. In the repo, go to **Settings → Pages**, set the source to your main
   branch, and save.
4. GitHub gives you a URL like `https://yourname.github.io/ledger-app/`.
   Open that on your phone and laptop.
5. On your phone, open the link in Chrome/Safari, tap the share/menu
   button, and choose **"Add to Home Screen."** It'll behave like an
   installed app (own icon, no browser bar, works offline after the
   first load).

## 3. The one thing to know about your data

Because there's no server, **your phone and your laptop each keep their
own copy of the data** — entering an expense on your phone will not
show up on your laptop by itself.

To move data between devices (or back it up), go to **More → Export
backup** on the device with the up-to-date data. That downloads a
`.json` file. On the other device, go to **More → Import backup** and
pick that file — it replaces everything on that device with the backup.
A simple habit: export from your phone at the end of the day, import
on your laptop when you want to review.

## 4. What's inside

- `index.html` / `style.css` / `app.js` — the whole app
- `seed-data.js` — your imported Excel data (edit this only if you want
  to change the *starting* data — once the app has run once, it ignores
  this file and uses what's saved in the browser)
- `manifest.json` / `sw.js` / `icons/` — what makes it installable and
  able to work offline

## 5. Where things live in the app

- **Dashboard** — total money across accounts, this month's in/out, debts,
  lending, upcoming bills, top spending
- **Add** — the one-tap entry form (like your Quick Entry sheet)
- **Transactions** — full searchable, filterable list (this replaces the
  slow-scrolling sheet)
- **Budget** — spending by category vs. a monthly budget you set
- **Debts & Lending** — your debts/EMIs, friend/family lending, and the
  chit fund
- **Bills & Calendar** — recurring bills (rent, electricity, EMIs…) with
  a "mark paid" button
- **Investments** — your holdings and their current value
- **More** — accounts, backup/restore, and reset
