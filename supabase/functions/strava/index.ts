// Meal Sync: Strava bridge.
// Holds the Strava client secret and each user's tokens so the browser never sees them.
// Secrets needed in Supabase: STRAVA_CLIENT_ID, STRAVA_CLIENT_SECRET.
import { createClient } from 'npm:@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const CLIENT_ID = Deno.env.get('STRAVA_CLIENT_ID') ?? '';
const CLIENT_SECRET = Deno.env.get('STRAVA_CLIENT_SECRET') ?? '';
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

async function stravaToken(params: Record<string, string>) {
  const res = await fetch('https://www.strava.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, ...params }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error('Strava refused the link (' + (data.message || res.status) + ')');
  return data;
}

// deno-lint-ignore no-explicit-any
async function freshToken(row: any) {
  const now = Math.floor(Date.now() / 1000);
  if (row.access_token && Number(row.expires_at) > now + 120) return row.access_token as string;
  const t = await stravaToken({ grant_type: 'refresh_token', refresh_token: row.refresh_token });
  await db.from('cc_strava').update({
    access_token: t.access_token,
    refresh_token: t.refresh_token,
    expires_at: t.expires_at,
    updated_at: new Date().toISOString(),
  }).eq('handle', row.handle);
  return t.access_token as string;
}

async function stravaGet(token: string, path: string) {
  const res = await fetch('https://www.strava.com/api/v3' + path, {
    headers: { Authorization: 'Bearer ' + token },
  });
  if (res.status === 401) throw new Error('reconnect');
  if (res.status === 429) throw new Error('Strava is rate limiting for a few minutes. It will catch up next time.');
  if (!res.ok) throw new Error('Strava error ' + res.status);
  return res.json();
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  // deno-lint-ignore no-explicit-any
  let b: any = {};
  try { b = await req.json(); } catch { return json({ error: 'Bad request' }, 400); }

  if (!CLIENT_ID || !CLIENT_SECRET) {
    return json({ error: 'Strava is not set up on the server yet (missing STRAVA_CLIENT_ID / STRAVA_CLIENT_SECRET).' }, 500);
  }

  try {
    // Finishing the Strava redirect. No passcode here: the one-time state
    // proves which user started it, and it may land in a different browser.
    if (b.action === 'connect') {
      if (typeof b.code !== 'string' || typeof b.state !== 'string') return json({ error: 'Missing code' }, 400);
      const { data: row } = await db.from('cc_strava').select('*')
        .eq('pending_state', b.state).maybeSingle();
      if (!row || !row.pending_at || Date.now() - Date.parse(row.pending_at) > 30 * 60 * 1000) {
        return json({ error: 'That Strava link has expired. Tap Connect again.' }, 400);
      }
      const t = await stravaToken({ grant_type: 'authorization_code', code: b.code });
      const athlete = t.athlete ? [t.athlete.firstname, t.athlete.lastname].filter(Boolean).join(' ') : '';
      await db.from('cc_strava').update({
        athlete_id: t.athlete ? t.athlete.id : null,
        athlete_name: athlete,
        access_token: t.access_token,
        refresh_token: t.refresh_token,
        expires_at: t.expires_at,
        pending_state: null,
        pending_at: null,
        connected_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).eq('handle', row.handle);
      return json({ ok: true, athlete });
    }

    if (!(await authed(b.handle, b.pass))) return json({ error: 'Sign in again to use Strava.' }, 401);
    const handle = b.handle as string;

    if (b.action === 'begin') {
      const state = crypto.randomUUID();
      const { error } = await db.from('cc_strava').upsert({
        handle, pending_state: state, pending_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }, { onConflict: 'handle' });
      if (error) throw new Error(error.message);
      return json({ state, client_id: CLIENT_ID });
    }

    const { data: row } = await db.from('cc_strava').select('*').eq('handle', handle).maybeSingle();
    const connected = !!(row && row.refresh_token);

    if (b.action === 'disconnect') {
      if (connected) {
        try {
          const token = await freshToken(row);
          await fetch('https://www.strava.com/oauth/deauthorize', {
            method: 'POST',
            headers: { Authorization: 'Bearer ' + token },
          });
        } catch { /* already revoked on Strava's side */ }
      }
      await db.from('cc_strava').delete().eq('handle', handle);
      return json({ ok: true });
    }

    if (b.action === 'skip') {
      if (!row || typeof b.sid !== 'string') return json({ ok: true });
      const skipped: string[] = Array.isArray(row.skipped) ? row.skipped : [];
      if (!skipped.includes(b.sid)) skipped.push(b.sid);
      await db.from('cc_strava').update({ skipped: skipped.slice(-500) }).eq('handle', handle);
      return json({ ok: true });
    }

    if (b.action === 'activities') {
      if (!connected) return json({ connected: false });
      const since = row.connected_at ? Math.floor(Date.parse(row.connected_at) / 1000) : 0;
      const after = Math.max(0, Math.floor(Number(b.after) || 0));
      const known = new Set<string>([
        ...(Array.isArray(b.known) ? b.known.map(String) : []),
        ...(Array.isArray(row.skipped) ? row.skipped.map(String) : []),
      ]);
      let token: string;
      // deno-lint-ignore no-explicit-any
      let list: any[];
      try {
        token = await freshToken(row);
        list = await stravaGet(token, '/athlete/activities?per_page=50&after=' + after);
      } catch (e) {
        if ((e as Error).message === 'reconnect') {
          await db.from('cc_strava').delete().eq('handle', handle);
          return json({ connected: false, error: 'Strava access was removed. Connect again in Settings.' });
        }
        throw e;
      }
      const fresh = list.filter((a) => !known.has(String(a.id))).slice(0, 15);
      const out = [];
      for (const a of fresh) {
        // Calories are only on the detailed activity, not in the list.
        let calories = 0;
        try {
          const d = await stravaGet(token, '/activities/' + a.id);
          calories = Number(d.calories) || 0;
        } catch { /* fall back to the app's estimate */ }
        out.push({
          id: String(a.id),
          name: a.name || '',
          sport_type: a.sport_type || a.type || '',
          start_date_local: a.start_date_local || '',
          moving_time: a.moving_time || 0,
          distance: a.distance || 0,
          kilojoules: a.kilojoules || 0,
          calories,
        });
      }
      return json({ connected: true, athlete: row.athlete_name || '', since, activities: out });
    }

    return json({ error: 'Unknown action' }, 400);
  } catch (e) {
    return json({ error: (e as Error).message || 'Strava link failed' }, 500);
  }
});
