# The sharing service

"Share with people" in the app (Drive-style invites, sign-in for viewers, who-watched
tracking, admin and member views) runs on ONE Supabase project owned by whoever
publishes the app. Until that project exists and its address is built into the app,
the feature stays hidden: Settings → Account says it is not switched on.

## Switching it on

1. Create a Supabase project (supabase.com → New project). Any region near your customers.
2. SQL Editor → paste all of `schema.sql` → Run. It creates the tables, the access
   functions, the `videos` storage bucket and its upload rule. Safe to run again.
3. Authentication → Emails → "Magic Link" template: make sure the body contains
   `{{ .Token }}` so people are emailed a six-digit code, e.g.
   `Your sign-in code is {{ .Token }}`.
4. Authentication → URL Configuration → Site URL: the share site's address
   (your own address, for example https://share.example.com).
5. Authentication → SMTP: connect a real email sender (Resend, Postmark, SES…). The
   built-in sender is limited to a handful of emails an hour and is for testing only.
6. Storage → Settings: raise the upload size limit to suit (the free plan caps a file
   at 50 MB; larger videos are shared as a smaller 720p copy automatically).
7. Project Settings → API: copy the Project URL and the `anon` / publishable key into
   - `package.json` → `knight.cloud` → `{ "url": "...", "key": "..." }`
   - `share-viewer/config.js` → `window.KS_CLOUD = { url: "...", key: "..." }`
   The anon key is public by design; every table has row level security on with no
   policies, so the key can only call the checked functions. NEVER put the
   service_role key in either file.
8. `cd share-viewer && npx vercel deploy --prod`, then build and ship the app.

## What it costs to run

Every customer's shared videos are stored and streamed from this one project, so
storage and bandwidth grow with use. On Supabase Pro (about $25 a month) that is
100 GB of storage and 250 GB of bandwidth included, then per-GB charges.

## How access works

Nothing reads a table directly. `ks_watch(video)` decides whether the caller may
watch and only then hands over the file's (long, random) path. `node
build/cloud-rules.mjs` runs 37 checks of those rules on a real local Postgres.

Known limit: a video's file address, once handed to someone allowed to watch, keeps
working for anyone they pass it to until the video is re-uploaded or taken down —
the same as anyone being able to download and forward a file they can watch.
