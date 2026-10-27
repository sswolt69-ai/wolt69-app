# One-time setup: send reports to Google Drive

This lets the app upload the monthly report PDF straight into **your own Google Drive**
(the shop's/your Google account, not Supabase, not Netlify — it uses your free 15GB Drive
storage, so nothing here costs anything or eats into Supabase/Netlify limits).

You only have to do this once.

## 1. Create a free Google Cloud project + OAuth Client ID

1. Go to https://console.cloud.google.com/ and sign in with the Google account you want
   reports saved to (your father's Google account, or your own).
2. Create a new project (top-left dropdown → "New Project"). Name it anything, e.g. "Wolt 69".
3. In the left menu: **APIs & Services → Library** → search "Google Drive API" → **Enable**.
4. **APIs & Services → OAuth consent screen**:
   - User type: **External**
   - App name: "Wolt 69", your email as support email
   - Scopes: you don't need to add any here (the app requests `drive.file` itself)
   - Test users: add the Google account email you'll actually use (e.g. your father's Gmail)
   - Leave it in **Testing** mode — that's fine forever for a personal app like this, no need
     to submit for Google verification.
5. **APIs & Services → Credentials → Create Credentials → OAuth client ID**:
   - Application type: **Web application**
   - Name: "Wolt 69 Web"
   - Authorized JavaScript origins — add BOTH of these:
     - `http://localhost:5173` (for when you test with `npm run dev`)
     - your real Netlify URL, e.g. `https://wolt69.netlify.app` (whatever your site's actual URL is)
   - Leave "Authorized redirect URIs" empty — not needed.
   - Click **Create**. Copy the **Client ID** (looks like `123456-abc.apps.googleusercontent.com`).

## 2. Put the Client ID into the app

**For local testing** — create a file named `.env` in the project root (same folder as
`package.json`) with this one line:

```
VITE_GOOGLE_CLIENT_ID=paste-your-client-id-here.apps.googleusercontent.com
```

Restart `npm run dev` after saving this file.

**For the live Netlify site** — in Netlify: **Site settings → Environment variables → Add a
variable**:
- Key: `VITE_GOOGLE_CLIENT_ID`
- Value: the same Client ID
Then trigger a new deploy (Netlify → Deploys → Trigger deploy) so it picks up the variable.

## 3. Using it

- On the **Today** screen, under "Backup / Reports", a **"📤 Send this month's report to
  Google Drive"** button appears once the Client ID is set up.
- The first time you tap it, Google will show a sign-in + consent popup (since the app is in
  "Testing" mode, only the test-user email you added in step 4 above can sign in — that's a
  Google safety rule for unverified apps, not a bug).
- After that first time, it won't ask again for about an hour per session.
- Files land in a folder called **"Wolt 69 Reports"** in that Google account's Drive, which
  the app creates automatically the first time.
- Early each month (days 1–7), a small banner will also appear on the Today screen reminding
  you to send last month's report — but only if the app is actually opened during those days
  (a closed app can't send anything by itself; there's no real background/scheduled sending
  without a paid server, so this is a reminder, not a guarantee).

If you skip this setup entirely, nothing breaks — the Drive buttons and the monthly nudge
simply won't appear, and everything else (PDF download, WhatsApp bill, JSON backup/restore)
works exactly as before.
