// Edge Function « envoyer-email » — Planning Astreinte Pasly
//
// Emails déclenchés depuis l'appli (remplace EmailJS) :
//   { action: 'publication', semaine_id }  → agent désigné de la semaine (admin)
//   { action: 'relance',     semaine_id }  → agents éligibles n'ayant pas répondu (admin)
//   { action: 'evenement',   evenement_id } → participants désignés (admin ou gestion événements)
//
// Sécurité : l'appli n'envoie que des identifiants. Destinataires et textes
// sont déterminés ICI, à partir de la base : impossible de s'en servir pour
// envoyer un message libre à une adresse quelconque. L'appelant doit être
// connecté, actif, et avoir le droit correspondant à l'action.
//
// Option test : { ..., test: true } (service_role uniquement) renvoie ce qui
// serait envoyé sans rien envoyer.
//
// Secrets : BREVO_API_KEY, BREVO_SENDER_EMAIL.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const BREVO_API_KEY = Deno.env.get('BREVO_API_KEY') ?? '';
const SENDER_EMAIL = Deno.env.get('BREVO_SENDER_EMAIL') ?? '';
const SENDER_NAME = 'Commune de Pasly — Astreintes';
const APP_URL = 'https://f07303988-hub.github.io/Planning-Astreinte-Pasly/';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};
function reponse(corps: unknown, status = 200) {
  return new Response(JSON.stringify(corps), { status, headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' } });
}

function dateLongue(iso: string): string {
  return new Date(iso + 'T12:00:00Z').toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
}
function echapper(s: string): string {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

async function envoyer(email: string, nom: string, sujet: string, texte: string): Promise<void> {
  const html = `<p>Bonjour ${echapper(nom)},</p><p>${echapper(texte)}</p>` +
    `<p><a href="${APP_URL}">Ouvrir le planning des astreintes</a></p>` +
    `<p style="color:#777;font-size:12px">Message automatique — Commune de Pasly.</p>`;
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': BREVO_API_KEY, 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({
      sender: { name: SENDER_NAME, email: SENDER_EMAIL },
      to: [{ email, name: nom }],
      subject: sujet,
      htmlContent: html,
      textContent: `Bonjour ${nom},\n\n${texte}\n\n${APP_URL}`
    })
  });
  if (!res.ok) throw new Error(`Brevo ${res.status} : ${await res.text()}`);
}

function roleDuJeton(jwt: string): string | null {
  try { return JSON.parse(atob(jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).role ?? null; }
  catch { return null; }
}

type Message = { email: string; nom: string; sujet: string; texte: string };

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return reponse({ erreur: 'Méthode non autorisée.' }, 405);

  const sb = createClient(SUPABASE_URL, SERVICE_KEY);
  const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  const estServeur = roleDuJeton(jwt) === 'service_role';

  // ---- Qui appelle ? ----
  let appelant: { id: string; role: string; actif: boolean; peut_gerer_evenements: boolean } | null = null;
  if (!estServeur) {
    const { data: u, error } = await sb.auth.getUser(jwt);
    if (error || !u?.user?.email) return reponse({ erreur: 'Connexion requise.' }, 401);
    const { data: a } = await sb.from('agents').select('id, role, actif, peut_gerer_evenements')
      .ilike('email', u.user.email).maybeSingle();
    if (!a || !a.actif) return reponse({ erreur: 'Compte non autorisé.' }, 403);
    appelant = a;
  }
  const estAdmin = estServeur || appelant?.role === 'admin';
  const gereEvenements = estAdmin || !!appelant?.peut_gerer_evenements;

  let corps: { action?: string; semaine_id?: string; evenement_id?: string; test?: boolean };
  try { corps = await req.json(); } catch { return reponse({ erreur: 'Requête invalide.' }, 400); }
  const test = estServeur && corps.test === true;
  if (!test && (!BREVO_API_KEY || !SENDER_EMAIL)) return reponse({ erreur: 'Envoi d\'emails non configuré sur le serveur.' }, 500);

  const messages: Message[] = [];

  if (corps.action === 'publication' || corps.action === 'relance') {
    if (!estAdmin) return reponse({ erreur: 'Réservé aux administrateurs.' }, 403);
    const { data: s } = await sb.from('semaines').select('*').eq('id', corps.semaine_id ?? '').maybeSingle();
    if (!s) return reponse({ erreur: 'Semaine introuvable.' }, 404);
    const periode = `du ${dateLongue(s.date_debut)} au ${dateLongue(s.date_fin)}`;

    if (corps.action === 'publication') {
      if (s.statut !== 'publiee') return reponse({ erreur: 'Cette semaine n\'est pas publiée.' }, 409);
      const { data: p } = await sb.from('planning').select('agent_id').eq('semaine_id', s.id).maybeSingle();
      const { data: a } = p ? await sb.from('agents').select('nom, email, actif').eq('id', p.agent_id).maybeSingle() : { data: null };
      if (!a || !a.actif || !a.email) return reponse({ erreur: 'Aucun agent joignable pour cette semaine.' }, 409);
      messages.push({ email: a.email, nom: a.nom, sujet: 'Vous êtes d\'astreinte',
        texte: `Vous êtes désigné(e) d'astreinte pour la semaine ${periode}.` });
    } else {
      if (s.statut !== 'ouverte') return reponse({ erreur: 'Cette semaine n\'est plus ouverte aux disponibilités.' }, 409);
      const [{ data: agents }, { data: dispos }] = await Promise.all([
        sb.from('agents').select('id, nom, email, role, actif, eligible_astreinte, categorie'),
        sb.from('disponibilites').select('agent_id').eq('semaine_id', s.id)
      ]);
      const ontRepondu = new Set((dispos ?? []).map(d => d.agent_id));
      for (const a of agents ?? []) {
        if (!a.actif || !a.email || a.role === 'lecteur' || a.eligible_astreinte === false || a.categorie === 'communal') continue;
        if (ontRepondu.has(a.id)) continue;
        messages.push({ email: a.email, nom: a.nom, sujet: 'Rappel — Déclarez votre disponibilité',
          texte: `Merci de déclarer votre disponibilité pour la semaine ${periode}, avant le ${dateLongue(s.date_limite_dispo)}.` });
      }
    }
  } else if (corps.action === 'evenement') {
    if (!gereEvenements) return reponse({ erreur: 'Vous ne gérez pas les événements.' }, 403);
    const { data: ev } = await sb.from('evenements').select('*').eq('id', corps.evenement_id ?? '').maybeSingle();
    if (!ev) return reponse({ erreur: 'Événement introuvable.' }, 404);
    const { data: liens } = await sb.from('evenements_agents').select('agent_id').eq('evenement_id', ev.id);
    const ids = (liens ?? []).map(l => l.agent_id);
    const { data: agents } = ids.length ? await sb.from('agents').select('nom, email, actif').in('id', ids) : { data: [] };
    for (const a of agents ?? []) {
      if (!a.actif || !a.email) continue;
      messages.push({ email: a.email, nom: a.nom, sujet: `Vous êtes désigné(e) — ${ev.intitule}`,
        texte: `Vous êtes désigné(e) comme participant pour : ${ev.intitule}, le ${dateLongue(ev.date)}` +
          `${ev.heure ? ' à ' + ev.heure : ''}${ev.lieu ? ' (' + ev.lieu + ')' : ''}.` });
    }
  } else {
    return reponse({ erreur: 'Action inconnue.' }, 400);
  }

  if (test) return reponse({ test: true, envoyes: 0, prevus: messages.map(m => ({ a: m.nom, sujet: m.sujet })) });

  let envoyes = 0; const echecs: string[] = [];
  for (const m of messages) {
    try { await envoyer(m.email, m.nom, m.sujet, m.texte); envoyes++; }
    catch (e) { echecs.push(`${m.nom} : ${e}`); console.error(e); }
  }
  return reponse({ envoyes, echecs: echecs.length });
});
