# WOLT 69 — mobile and data-safety patch

## Changes made to this ZIP
- Adjusted iOS/Android viewport and bottom-sheet scrolling, safe-area handling, small-screen header spacing, and input sizing to reduce iOS keyboard zoom/clipping. These are code-level fixes, not physical-device test results.
- Removed the visualViewport scroll listener that could cause keyboard/sheet jumping.
- Loaded Supabase records using stable, ID-ordered 500-row pages rather than silently stopping at the default row limit. Loading errors now show a toast instead of silently replacing existing data with empty arrays.
- Changed **JSON Backup** to explicitly fetch and export every table, including soft-deleted records. It reports fetch failures instead of exporting a partial backup.
- Disabled the unsafe browser-based full restore, which previously cleared production tables before attempting a multi-step reinsert. Backups can still be exported. Restoring must be implemented as a server-side, transactional operation and tested in a disposable database.
- Added timestamps to **new** payment entries and database error messages to add-payment and add-line operations.
- Extended JSON download URL lifetime to better support Safari.

## Still NOT fixed — do not assume these are complete
1. **Supabase RLS**: Existing SQL grants any authenticated user all records. Lock permissions down to the exact owner's auth UID, but confirm that UID and back up the live database before changing policies. Do not run the old schema again on the live database.
2. **Atomic stock**: Job JSON updates and stock movements still use two separate API requests. Failed stock updates now show an error but can still leave a line saved without a stock movement. Correct this with a tested `SECURITY INVOKER` database RPC transaction and suitable authorization. Also protect against simultaneous edits and duplicate taps.
3. **Full restore**: A verified server-side, transactional restore is not provided here. Never delete live records to test restoration; test only on a separate Supabase project.
4. **Profit reporting**: Currently a simplified cash-flow view, not an audited profit and loss statement. Historical payments without timestamps cannot be placed reliably into collection dates.
5. **Realtime performance**: All tables reload on events; larger datasets may need debounce/incremental updates, or server-side paging on screens rather than loading the entire database.
6. **Schema drift**: `supabase-schema.sql` is an old baseline and does not define all fields used by this React app. Existing live migrations and table columns must be inventoried before creating schema migrations.
7. **Physical device QA**: Not performed. Test iPhone Safari and Add to Home Screen, Android Chrome and installed PWA, keyboard open/close, rotate, zoom, PDF downloads, offline/online transitions, and navigation with long lists.
8. **Backups**: Manual JSON export is not an automatic scheduled external backup. Store exports in independent protected storage and test a restore separately.

## Safe deployment
1. First download a backup from the CURRENT live app and store a copy outside Netlify/Supabase. Ensure it contains all 12 tables; existing backup behavior may be limited by Supabase row limits.
2. Create a separate staging branch and Netlify preview deployment. Do not replace production immediately.
3. Install dependencies with `npm ci` and validate with `npm run build`. The build could **not** be run in this offline environment (`vite: not found`); this ZIP is source changes, not a verified production build.
4. Test the mobile QA cases above using a **test** Supabase database and inspect errors in browser developer tools.
5. Compare backups with actual per-table row counts, then deploy to production and monitor.

## Security notes
Never commit `.env`, Supabase service-role keys, Google OAuth client secrets, or database passwords. The public Supabase anon key is only safe with correctly configured RLS. Require owner-only auth, disable public signups, and review all exposed table policies.
