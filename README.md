# Meal Sync

A single-file, photo-first calorie tracker built for iPhone, hosted on GitHub Pages.

Snap or describe a meal and Claude estimates the items, grams, calories and macros. Everything is editable, favourites log in one tap, the last meal can be copied in one tap, Garmin activities (with your watch's calories) flow in automatically, nutrition labels can be scanned into a My foods list, exercise can also be typed or pasted, and a profile drives maintenance and target-weight maths.

## How it works

- The whole app is `index.html`. No build step, no dependencies.
- All data lives in the browser's localStorage on the phone, so the app is instant and works offline for viewing and manual logging.
- With sync configured in Settings, the app also backs everything up to Supabase in the background and joins a small leaderboard with anyone else on the same database. Weights are never shared; the leaderboard sees only daily calories, protein, burn and goal-hit.
- Meal estimation calls the Anthropic API directly from the browser.

## Deploying

Replace `index.html` on the `main` branch and GitHub Pages does the rest. On the phone, open the Pages URL in Safari and Add to Home Screen.

## Sync setup (one-off)

Run `cc_migration.sql` in the Supabase SQL editor, then enter the project URL, anon key, a handle and a sync code in the app's Settings. The sync code is the password for your data; keep a copy.

## Garmin setup (one-off)

1. In Garmin Connect, create a Personal API key at https://connect.garmin.com/app/settings/personalApiToken (choose the 1 year option and copy it, it is shown only once).
2. In the app: Settings > Connect Garmin, paste the key, tap Save key and connect.
3. New activities from that day onwards are imported each time the app opens, with the calories your watch recorded. Deleting an imported activity stops it coming back.

`garmin_migration.sql` creates the `cc_garmin` table and `supabase/functions/garmin/index.ts` is the edge function that holds the key and swaps it for Garmin's 24-hour token. Both are applied to the project.

The earlier Strava link (`strava_migration.sql`, `supabase/functions/strava`) is no longer used by the app.
