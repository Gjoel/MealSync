// Meal Sync: evening reminder push notifications.
// Called hourly by pg_cron (with the cron secret) and sends each subscribed
// phone a short status at the hour its owner picked, in their own time zone.
// The app can also call it with {action:'test'} to send one straight away.
import { createClient } from 'npm:@supabase/supabase-js@2';
import webpush from 'npm:web-push@3.6.7';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const APP_URL = 'https://gjoel.github.io/MealSync/';
const db = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  { auth: { persistSession: false } },
);
const nf = new Intl.NumberFormat('en-AU');

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}
function localParts(tz: string) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' });
  const p: Record<string, string> = {};
  f.formatToParts(new Date()).forEach((x) => { p[x.type] = x.value; });
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) };
}

// deno-lint-ignore no-explicit-any
async function compose(handle: string, date: string): Promise<{ title: string; body: string }> {
  const { data: rows } = await db.from('cc_state').select('kind,data').eq('handle', handle).in('kind', ['log', 'profile']);
  // deno-lint-ignore no-explicit-any
  const by: Record<string, any> = {};
  (rows || []).forEach((r) => { by[r.kind] = r.data; });
  // deno-lint-ignore no-explicit-any
  const meals: any[] = (by.log && by.log[date]) || [];
  const prof = by.profile || {};
  const { data: dayRow } = await db.from('cc_days').select('goal').eq('handle', handle).eq('day', date).maybeSingle();
  const goal = Number(prof.goal) || Number(dayRow && dayRow.goal) || 0;
  const pgoal = Number(prof.pgoal) || 0;
  if (!meals.length) {
    return { title: 'Nothing logged today', body: 'Add what you have eaten so today counts. A photo is enough.' };
  }
  let kcal = 0, p = 0;
  // deno-lint-ignore no-explicit-any
  meals.forEach((m) => (m.items || []).forEach((i: any) => { kcal += Number(i.kcal) || 0; p += Number(i.p) || 0; }));
  const last = meals.map((m) => String(m.time || '')).filter(Boolean).sort().pop() || '';
  const bits: string[] = [];
  if (goal) {
    bits.push(kcal <= goal
      ? `${nf.format(Math.round(kcal))} kcal eaten, ${nf.format(Math.round(goal - kcal))} left of ${nf.format(goal)}.`
      : `${nf.format(Math.round(kcal))} kcal eaten, ${nf.format(Math.round(kcal - goal))} over ${nf.format(goal)}.`);
  } else bits.push(`${nf.format(Math.round(kcal))} kcal eaten so far.`);
  if (pgoal) {
    bits.push(p >= pgoal ? `Protein goal hit (${Math.round(p)} g).` : `Protein ${Math.round(p)} of ${pgoal} g, ${Math.round(pgoal - p)} g to go.`);
  }
  if (last && last < '15:00') {
    return { title: 'Nothing logged since lunch', body: `Last entry at ${last}. Add dinner before you forget. ` + bits.join(' ') };
  }
  return { title: 'Today so far', body: bits.join(' ') };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  const { data: cfg } = await db.from('cc_push_cfg').select('*').eq('id', 1).single();
  if (!cfg) return json({ error: 'not configured' }, 500);
  webpush.setVapidDetails('mailto:noreply@mealsync.app', cfg.vapid_public, cfg.vapid_private);

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* cron sends {} */ }
  const isCron = req.headers.get('x-cron-secret') === cfg.cron_secret;
  let handleOnly = '';
  if (!isCron) {
    if (body.action !== 'test' || typeof body.handle !== 'string' || typeof body.pass !== 'string') return json({ error: 'forbidden' }, 403);
    const { data } = await db.rpc('cc_login', { p_handle: body.handle, p_pass: body.pass });
    if (data !== 'ok') return json({ error: 'auth failed' }, 403);
    handleOnly = body.handle;
  }

  let q = db.from('cc_push_subs').select('*');
  if (handleOnly) q = q.eq('handle', handleOnly);
  const { data: subs } = await q;
  let sent = 0, gone = 0;
  for (const s of subs || []) {
    const lp = localParts(s.tz || 'Australia/Sydney');
    if (!handleOnly && (lp.hour !== s.hour || s.last_sent === lp.date)) continue;
    const msg = await compose(s.handle, lp.date);
    try {
      await webpush.sendNotification(s.sub, JSON.stringify({ ...msg, url: APP_URL, tag: 'evening' }), { TTL: 3600 });
      sent++;
      if (!handleOnly) await db.from('cc_push_subs').update({ last_sent: lp.date }).eq('endpoint', s.endpoint);
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      console.log('push failed', code, (e as Error).message);
      if (code === 404 || code === 410) { await db.from('cc_push_subs').delete().eq('endpoint', s.endpoint); gone++; }
    }
  }
  return json({ ok: true, sent, gone, subs: (subs || []).length });
});
