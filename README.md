# Meal Sync

A single-file, photo-first calorie tracker built for iPhone, hosted on GitHub Pages.

Snap or describe a meal and Claude estimates the items, grams, calories and macros. Everything is editable, favourites log in one tap, the last meal can be copied in one tap, Strava activities (with calories) flow in automatically, exercise can also be typed or pasted from a Garmin summary, and a profile drives maintenance and target-weight maths.

## How it works

- The whole app is `index.html`. No build step, no dependencies.
- All data lives in the browser's localStorage on the phone, so the app is instant and works offline for viewing and manual logging.
- With sync configured in Settings, the app also backs everything up to Supabase in the background and joins a small leaderboard with anyone else on the same database. Weights are never shared; the leaderboard sees only daily calories, protein, burn and goal-hit.
- Meal estimation calls the Anthropic API directly from the browser.

## Deploying

Replace `index.html` on the `main` branch and GitHub Pages does the rest. On the phone, open the Pages URL in Safari and Add to Home Screen.

## Sync setup (one-off)

Run `cc_migration.sql` in the Supabase SQL editor, then enter the project URL, anon key, a handle and a sync code in the app's Settings. The sync code is the password for your data; keep a copy.

## Strava setup (one-off)

1. Create a Strava API app at https://www.strava.com/settings/api. Set **Authorization Callback Domain** to the GitHub Pages domain (for example `gjoel.github.io`).
2. In Supabase, go to Edge Functions > Secrets and add `STRAVA_CLIENT_ID` and `STRAVA_CLIENT_SECRET` from that Strava page.
3. `strava_migration.sql` creates the `cc_strava` table, and `supabase/functions/strava/index.ts` is the edge function that holds the tokens. Both are already applied to the project.
4. In the app: Settings > Connect with Strava. New activities from that day onwards are imported each time the app opens, and their calories add to the day's allowance. Deleting an imported activity stops it coming back.
