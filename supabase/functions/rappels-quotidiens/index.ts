// Edge Function « rappels-quotidiens » — Planning Astreinte Pasly
//
// Appelée chaque matin par une tâche programmée (pg_cron). Envoie via Brevo :
//   1. aux élus désignés, un rappel la veille (ou le jour même) d'un événement ;
//   2. à l'agent désigné, un rappel 48 h avant le début de son astreinte ;
//   3. aux admins, une alerte quand une semaine débute dans 15 jours ou moins
//      sans être publiée.
// Chaque rappel n'est marqué « envoyé » que si l'envoi a réussi : en cas
// d'échec (quota, panne), il est retenté le lendemain.
//
// Mode test : ?test=1 renvoie la liste de ce qui SERAIT envoyé, sans rien
// envoyer ni modifier.
//
// Secrets requis : BREVO_API_KEY, BREVO_SENDER_EMAIL (adresse validée dans Brevo).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const BREVO_API_KEY = Deno.env.get('BREVO_API_KEY') ?? '';
const SENDER_EMAIL = Deno.env.get('BREVO_SENDER_EMAIL') ?? '';
const SENDER_NAME = 'Commune de Pasly — Astreintes';
const APP_URL = 'https://f07303988-hub.github.io/Planning-Astreinte-Pasly/';

// ---------- Dates, toujours à l'heure de Paris ----------
function aujourdhuiParis(): string {
  // 'sv-SE' formate en AAAA-MM-JJ
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Paris' });
}
function ajouterJours(iso: string, n: number): string {
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function dateLongue(iso: string): string {
  return new Date(iso + 'T12:00:00Z').toLocaleDateString('fr-FR', {
    weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC'
  });
}
function echapper(s: string): string {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

// ---------- Envoi Brevo ----------
async function envoyer(to: { email: string; nom: string }, sujet: string, texte: string): Promise<void> {
  const html = `<p>Bonjour ${echapper(to.nom)},</p><p>${echapper(texte)}</p>` +
    `<p><a href="${APP_URL}">Ouvrir le planning des astreintes</a></p>` +
    `<p style="color:#777;font-size:12px">Message automatique — Commune de Pasly.</p>`;
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': BREVO_API_KEY, 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({
      sender: { name: SENDER_NAME, email: SENDER_EMAIL },
      to: [{ email: to.email, name: to.nom }],
      subject: sujet,
      htmlContent: html,
      textContent: `Bonjour ${to.nom},\n\n${texte}\n\n${APP_URL}`
    })
  });
  if (!res.ok) throw new Error(`Brevo ${res.status} : ${await res.text()}`);
}

// Seule la tâche programmée (clé service_role) peut déclencher la fonction.
function estAppelServeur(req: Request): boolean {
  const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  try {
    const payload = JSON.parse(atob(jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return payload.role === 'service_role';
  } catch { return false; }
}

type Envoi = { type: string; email: string; nom: string; sujet: string; texte: string };

Deno.serve(async (req) => {
  if (!estAppelServeur(req)) return new Response('Accès refusé.', { status: 403 });
  const test = new URL(req.url).searchParams.get('test') === '1';
  if (!test && (!BREVO_API_KEY || !SENDER_EMAIL)) {
    return new Response('Secrets BREVO_API_KEY / BREVO_SENDER_EMAIL manquants.', { status: 500 });
  }

  const sb = createClient(SUPABASE_URL, SERVICE_KEY);
  const today = aujourdhuiParis();
  const demain = ajouterJours(today, 1);
  const dans2j = ajouterJours(today, 2);
  const dans15j = ajouterJours(today, 15);

  const { data: agents, error: errA } = await sb.from('agents').select('id, nom, email, role, actif');
  if (errA) return new Response(errA.message, { status: 500 });
  const agentById = Object.fromEntries((agents ?? []).map(a => [a.id, a]));
  const admins = (agents ?? []).filter(a => a.role === 'admin' && a.actif && a.email);

  const rapport: Envoi[] = [];
  const echecs: string[] = [];

  // Envoie une série de messages ; renvoie true si TOUS sont partis.
  async function traiter(lot: Envoi[]): Promise<boolean> {
    let ok = true;
    for (const e of lot) {
      rapport.push(e);
      if (test) continue;
      try { await envoyer({ email: e.email, nom: e.nom }, e.sujet, e.texte); }
      catch (err) { ok = false; echecs.push(`${e.type} → ${e.email} : ${err}`); }
    }
    return ok;
  }

  // 1. Événements d'aujourd'hui ou de demain
  const { data: evenements } = await sb.from('evenements').select('*')
    .gte('date', today).lte('date', demain).eq('rappel_24h_envoye', false);
  if (evenements?.length) {
    const { data: liens } = await sb.from('evenements_agents').select('evenement_id, agent_id')
      .in('evenement_id', evenements.map(e => e.id));
    for (const ev of evenements) {
      const quand = ev.date === today ? "aujourd'hui" : 'demain';
      const lot = (liens ?? []).filter(l => l.evenement_id === ev.id)
        .map(l => agentById[l.agent_id]).filter(a => a && a.actif && a.email)
        .map(a => ({
          type: 'evenement', email: a.email, nom: a.nom,
          sujet: `Rappel — ${ev.intitule} ${quand}`,
          texte: `Vous êtes désigné(e) pour : ${ev.intitule}, ${quand} ${dateLongue(ev.date)}` +
            `${ev.heure ? ' à ' + ev.heure : ''}${ev.lieu ? ' (' + ev.lieu + ')' : ''}.`
        }));
      if (await traiter(lot) && !test) await sb.from('evenements').update({ rappel_24h_envoye: true }).eq('id', ev.id);
    }
  }

  // 2. Astreintes publiées débutant dans 48 h ou moins
  const { data: semainesProches } = await sb.from('semaines').select('*')
    .eq('statut', 'publiee').gte('date_debut', today).lte('date_debut', dans2j).eq('rappel_48h_envoye', false);
  if (semainesProches?.length) {
    const { data: plannings } = await sb.from('planning').select('semaine_id, agent_id')
      .in('semaine_id', semainesProches.map(s => s.id));
    for (const s of semainesProches) {
      const p = (plannings ?? []).find(p => p.semaine_id === s.id);
      const a = p && agentById[p.agent_id];
      const lot = (a && a.actif && a.email) ? [{
        type: 'astreinte', email: a.email, nom: a.nom,
        sujet: 'Rappel — Votre astreinte débute bientôt',
        texte: `Votre astreinte débute le ${dateLongue(s.date_debut)} et se termine le ${dateLongue(s.date_fin)}.`
      }] : [];
      if (await traiter(lot) && !test) await sb.from('semaines').update({ rappel_48h_envoye: true }).eq('id', s.id);
    }
  }

  // 3. Semaines non publiées dans 15 jours ou moins → alerte aux admins
  const { data: nonPubliees } = await sb.from('semaines').select('*')
    .neq('statut', 'publiee').gte('date_debut', today).lte('date_debut', dans15j).eq('rappel_non_prise_envoye', false);
  for (const s of nonPubliees ?? []) {
    const lot = admins.map(a => ({
      type: 'non_publiee', email: a.email, nom: a.nom,
      sujet: 'Planning à vérifier',
      texte: `La semaine du ${dateLongue(s.date_debut)} au ${dateLongue(s.date_fin)} n'est toujours pas publiée alors qu'elle approche.`
    }));
    if (await traiter(lot) && !test) await sb.from('semaines').update({ rappel_non_prise_envoye: true }).eq('id', s.id);
  }

  const resume = { mode: test ? 'test (rien envoyé)' : 'réel', date: today, envois: rapport.length, echecs, detail: rapport.map(r => ({ type: r.type, a: r.nom, sujet: r.sujet })) };
  return new Response(JSON.stringify(resume, null, 2), { status: echecs.length ? 500 : 200, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
});
