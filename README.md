# Meal Sync

A single-file, photo-first calorie tracker built for iPhone, hosted on GitHub Pages.

Snap or describe a meal and Claude estimates the items, grams, calories and macros. Everything is editable, favourites log in one tap, exercise can be typed or pasted straight from a Strava or Garmin summary, and a profile drives maintenance and target-weight maths.

## How it works

- The whole app is `index.html`. No build step, no dependencies.
- All data lives in the browser's localStorage on the phone, so the app is instant and works offline for viewing and manual logging.
- With sync configured in Settings, the app also backs everything up to Supabase in the background and joins a small leaderboard with anyone else on the same database. Weights are never shared; the leaderboard sees only daily calories, protein, burn and goal-hit.
- Meal estimation calls the Anthropic API directly from the browser.

## Deploying

Replace `index.html` on the `main` branch and GitHub Pages does the rest. On the phone, open the Pages URL in Safari and Add to Home Screen.

## Sync setup (one-off)

Run `cc_migration.sql` in the Supabase SQL editor, then enter the project URL, anon key, a handle and a sync code in the app's Settings. The sync code is the password for your data; keep a copy.
