// Meal Sync: Garmin bridge (Garmin Connect Personal API).
// Keeps each user's Personal API key on the server and swaps it for the
// 24-hour bearer token Garmin requires, so the phone never holds either.
import { createClient } from 'npm:@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const BASE = 'https://personal.connectapi.garmin.com';
const TOKEN_PATH = '/personalapitoken-service/personal-api/personal-api-key/token';
const BAD_KEY = 'Garmin rejected the API key. It may have expired. Create a new one in Garmin Connect and paste it in Settings.';
const db = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  { auth: { persistSession: false } },
);

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

async function authed(handle: unknown, pass: unknown) {
  if (typeof handle !== 'string' || typeof pass !== 'string') return false;
  const { data, error } = await db.rpc('cc_login', { p_handle: handle, p_pass: pass });
  return !error && data === 'ok';
}

function jwtExp(token: string) {
  try {
    let p = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    while (p.length % 4) p += '=';
    return Number(JSON.parse(atob(p)).exp) || 0;
  } catch {
    return 0;
  }
}

// Exchange the Personal API key for a bearer token (there are no refresh tokens).
async function newToken(key: string) {
  const res = await fetch(BASE + TOKEN_PATH, {
    method: 'POST',
    headers: { Accept: '*/*', Authorization: 'ApiKey ' + key },
  });
  let text = (await res.text()).trim();
  if (res.status === 401 || res.status === 403) throw new Error('badkey');
  if (!res.ok || !text) throw new Error('Garmin token request failed (' + res.status + ')');
  if (text.startsWith('{')) {
    try { const j = JSON.parse(text); text = j.access_token || j.token || ''; } catch { /* use as is */ }
  }
  const exp = jwtExp(text) || Math.floor(Date.now() / 1000) + 23 * 3600;
  return { token: text, exp };
}

// deno-lint-ignore no-explicit-any
async function freshToken(row: any, force = false) {
  const now = Math.floor(Date.now() / 1000);
  if (!force && row.access_token && Number(row.token_exp) > now + 3600) return row.access_token as string;
  const t = await newToken(row.api_key);
  await db.from('cc_garmin').update({
    access_token: t.token, token_exp: t.exp, updated_at: new Date().toISOString(),
  }).eq('handle', row.handle);
  return t.token;
}

async function garminGet(token: string, path: string) {
  const res = await fetch(BASE + path, {
    headers: { Accept: 'application/json', Authorization: 'Bearer ' + token },
  });
  if (res.status === 401) throw new Error('reauth');
  if (res.status === 429) throw new Error('Garmin is rate limiting for a few minutes. It will catch up next time.');
  if (!res.ok) throw new Error('Garmin error ' + res.status);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// Flatten nested objects so calorie fields can be found whatever the nesting.
// deno-lint-ignore no-explicit-any
function flat(o: any, pre = '', out: Record<string, unknown> = {}, depth = 0) {
  if (!o || typeof o !== 'object' || depth > 3) return out;
  for (const [k, v] of Object.entries(o)) {
    const key = pre ? pre + '.' + k : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flat(v, key, out, depth + 1);
    else out[key] = v;
  }
  return out;
}
function pickNum(f: Record<string, unknown>, re: RegExp) {
  for (const [k, v] of Object.entries(f)) {
    const lk = k.toLowerCase();
    if (/goal|remaining|consumed|net/.test(lk)) continue;
    if (re.test(lk) && typeof v === 'number' && v > 0) return Math.round(v);
  }
  return 0;
}
// deno-lint-ignore no-explicit-any
function dayCalories(d: any) {
  const f = flat(d);
  const date = String(d.calendarDate ?? d.date ?? d.summaryDate ?? f['calendarDate'] ?? '').slice(0, 10);
  const active = pickNum(f, /activekilocalories|activecalories/);
  const bmr = pickNum(f, /bmrkilocalories|bmrcalories|restingcalories/);
  const total = pickNum(f, /totalkilocalories|totalcalories/) || (active + bmr);
  return { date, total, active, bmr };
}
// Garmin's whole-day burn (resting + steps + workouts) for each day in range.
async function dailyTotals(token: string, start: string, end: string) {
  try {
    const raw = await garminGet(token, '/usersummary-service/v2/dailysummaries?startDate=' + start + '&endDate=' + end);
    // deno-lint-ignore no-explicit-any
    const list: any[] = Array.isArray(raw) ? raw : (raw && (raw.data || raw.dailySummaries)) || [];
    console.log('garmin daily', list.length, 'keys:', Object.keys(flat(list[list.length - 1] || {})).slice(0, 60).join(','));
    const days = list.map(dayCalories).filter((d) => /^\d{4}-\d\d-\d\d$/.test(d.date) && d.total > 0);
    if (days.length) return days;
  } catch (e) {
    console.log('garmin daily v2 failed', (e as Error).message);
  }
  try {
    const one = await garminGet(token, '/usersummary-service/usersummary/daily?calendarDate=' + end);
    console.log('garmin daily single keys:', Object.keys(flat(one || {})).slice(0, 60).join(','));
    const d = dayCalories(one || {});
    if (!d.date) d.date = end;
    return d.total > 0 ? [d] : [];
  } catch (e) {
    console.log('garmin daily single failed', (e as Error).message);
    return [];
  }
}

const isoDate = (v: unknown) => (typeof v === 'string' && /^\d{4}-\d\d-\d\d$/.test(v)) ? v : '';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  // deno-lint-ignore no-explicit-any
  let b: any = {};
  try { b = await req.json(); } catch { return json({ error: 'Bad request' }, 400); }

  try {
    if (!(await authed(b.handle, b.pass))) return json({ error: 'Sign in again to use Garmin.' }, 401);
    const handle = b.handle as string;

    if (b.action === 'connect') {
      const key = typeof b.key === 'string' ? b.key.trim() : '';
      if (key.length < 10) return json({ error: 'That does not look like a Garmin API key.' }, 400);
      let t;
      try { t = await newToken(key); } catch (e) {
        if ((e as Error).message === 'badkey') return json({ error: BAD_KEY }, 400);
        throw e;
      }
      const { error } = await db.from('cc_garmin').upsert({
        handle, api_key: key, access_token: t.token, token_exp: t.exp,
        connected_at: new Date().toISOString(), skipped: [], updated_at: new Date().toISOString(),
      }, { onConflict: 'handle' });
      if (error) throw new Error(error.message);
      return json({ ok: true });
    }

    const { data: row } = await db.from('cc_garmin').select('*').eq('handle', handle).maybeSingle();

    if (b.action === 'disconnect') {
      await db.from('cc_garmin').delete().eq('handle', handle);
      return json({ ok: true });
    }

    if (b.action === 'skip') {
      if (!row || typeof b.sid !== 'string') return json({ ok: true });
      const skipped: string[] = Array.isArray(row.skipped) ? row.skipped : [];
      if (!skipped.includes(b.sid)) skipped.push(b.sid);
      await db.from('cc_garmin').update({ skipped: skipped.slice(-500) }).eq('handle', handle);
      return json({ ok: true });
    }

    if (b.action === 'activities') {
      if (!row) return json({ connected: false });
      const start = isoDate(b.startDate), end = isoDate(b.endDate);
      if (!start || !end) return json({ error: 'Missing dates' }, 400);
      const path = '/activitylist-service/activities/search/activities?start=0&limit=50' +
        '&startDate=' + start + '&endDate=' + end;

      // deno-lint-ignore no-explicit-any
      let raw: any;
      let token: string;
      try {
        token = await freshToken(row);
        try {
          raw = await garminGet(token, path);
        } catch (e) {
          if ((e as Error).message !== 'reauth') throw e;
          token = await freshToken(row, true);
          raw = await garminGet(token, path);
        }
      } catch (e) {
        const m = (e as Error).message;
        if (m === 'badkey' || m === 'reauth') {
          await db.from('cc_garmin').delete().eq('handle', handle);
          return json({ connected: false, error: BAD_KEY });
        }
        throw e;
      }

      // deno-lint-ignore no-explicit-any
      const list: any[] = Array.isArray(raw) ? raw
        : (raw && (raw.activities || raw.activityList || raw.data)) || [];
      // Field names only, no personal data: helps diagnose Garmin format changes.
      console.log('garmin activities', list.length, 'keys:', Object.keys(list[0] || {}).slice(0, 40).join(','));

      const known = new Set<string>([
        ...(Array.isArray(b.known) ? b.known.map(String) : []),
        ...(Array.isArray(row.skipped) ? row.skipped.map(String) : []),
      ]);
      const out = [];
      let detailCalls = 0;
      for (const a of list) {
        const id = String(a.activityId ?? a.id ?? '');
        if (!id || known.has(id)) continue;
        let calories = Number(a.calories ?? a.activeKilocalories ?? 0) || 0;
        if (!calories && detailCalls < 10) {
          detailCalls++;
          try {
            const d = await garminGet(token, '/activity-service/activity/' + id);
            calories = Number(d?.summaryDTO?.calories ?? d?.calories ?? 0) || 0;
          } catch { /* the app estimates instead */ }
        }
        out.push({
          id,
          name: String(a.activityName ?? a.name ?? ''),
          type: String(a.activityType?.typeKey ?? a.activityType ?? ''),
          start_local: String(a.startTimeLocal ?? a.activityDate ?? ''),
          moving_s: Number(a.movingDuration ?? a.duration ?? a.elapsedDuration ?? 0) || 0,
          calories,
        });
      }
      const days = await dailyTotals(token, start, end);
      const since = Math.floor(Date.parse(row.connected_at) / 1000) || 0;
      return json({ connected: true, since, activities: out, days });
    }

    return json({ error: 'Unknown action' }, 400);
  } catch (e) {
    return json({ error: (e as Error).message || 'Garmin link failed' }, 500);
  }
});
