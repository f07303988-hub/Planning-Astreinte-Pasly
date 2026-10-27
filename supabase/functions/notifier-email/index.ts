// Edge Function « notifier-email » — Planning Astreinte Pasly
//
// Déclenchée par la base (déclencheurs + pg_net), jamais par l'appli :
//   { notification_id }  → envoie par email une notification d'échange ou de
//                          remplacement (reçue, acceptée, refusée) à son destinataire ;
//   { echange_ouvert_id } / { remplacement_ouvert_id }
//                        → demande « ouverte à tous » : prévient chaque agent
//                          éligible (sauf le demandeur).
// Réservée à la clé service_role.
//
// Secrets : BREVO_API_KEY, BREVO_SENDER_EMAIL.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const BREVO_API_KEY = Deno.env.get('BREVO_API_KEY') ?? '';
const SENDER_EMAIL = Deno.env.get('BREVO_SENDER_EMAIL') ?? '';
const SENDER_NAME = 'Commune de Pasly — Astreintes';
const APP_URL = 'https://f07303988-hub.github.io/Planning-Astreinte-Pasly/';

const SUJETS: Record<string, string> = {
  echange_recu: 'Demande d\'échange d\'astreinte',
  echange_accepte: 'Échange d\'astreinte accepté',
  echange_refuse: 'Échange d\'astreinte refusé',
  remplacement_recu: 'Demande de remplacement d\'astreinte',
  remplacement_accepte: 'Remplacement d\'astreinte accepté',
  remplacement_refuse: 'Remplacement d\'astreinte refusé'
};
const A_REPONDRE = ['echange_recu', 'remplacement_recu'];

function dateLongue(iso: string): string {
  return new Date(iso + 'T12:00:00Z').toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
}
function echapper(s: string): string {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
// Retire l'émoji placé en tête des messages de notification.
function sansEmoji(s: string): string {
  return String(s ?? '').replace(/^[^\p{L}\p{N}]+/u, '').trim();
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

function estAppelServeur(req: Request): boolean {
  const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  try { return JSON.parse(atob(jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).role === 'service_role'; }
  catch { return false; }
}

const json = (corps: unknown, status = 200) =>
  new Response(JSON.stringify(corps), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });

Deno.serve(async (req) => {
  if (!estAppelServeur(req)) return json({ erreur: 'Accès refusé.' }, 403);
  if (!BREVO_API_KEY || !SENDER_EMAIL) return json({ erreur: 'Envoi non configuré.' }, 500);
  const sb = createClient(SUPABASE_URL, SERVICE_KEY);
  const corps = await req.json().catch(() => ({}));
  const messages: { email: string; nom: string; sujet: string; texte: string }[] = [];

  if (corps.notification_id) {
    const { data: n } = await sb.from('notifications').select('agent_id, type, message').eq('id', corps.notification_id).maybeSingle();
    if (!n || !SUJETS[n.type]) return json({ ignore: true });
    const { data: a } = await sb.from('agents').select('nom, email, actif').eq('id', n.agent_id).maybeSingle();
    if (!a || !a.actif || !a.email) return json({ ignore: true });
    const suite = A_REPONDRE.includes(n.type) ? ' Pour répondre, ouvrez l\'appli, onglet « Échanges ».' : '';
    messages.push({ email: a.email, nom: a.nom, sujet: SUJETS[n.type], texte: sansEmoji(n.message) + suite });

  } else if (corps.echange_ouvert_id || corps.remplacement_ouvert_id) {
    const estEchange = !!corps.echange_ouvert_id;
    const { data: d } = estEchange
      ? await sb.from('echanges').select('agent_demandeur_id, statut, semaines(date_debut, date_fin)').eq('id', corps.echange_ouvert_id).maybeSingle()
      : await sb.from('remplacements_jour').select('agent_demandeur_id, statut, date').eq('id', corps.remplacement_ouvert_id).maybeSingle();
    if (!d || d.statut !== 'attente') return json({ ignore: true });
    const { data: agents } = await sb.from('agents').select('id, nom, email, role, actif, eligible_astreinte, categorie');
    const demandeur = (agents ?? []).find(a => a.id === d.agent_demandeur_id);
    const qui = demandeur ? demandeur.nom : 'Un agent';
    const texte = estEchange
      ? `${qui} cherche quelqu'un pour reprendre sa semaine d'astreinte du ${dateLongue((d as any).semaines.date_debut)} au ${dateLongue((d as any).semaines.date_fin)}. Si vous pouvez la prendre, ouvrez l'appli, onglet « Échanges ».`
      : `${qui} cherche un remplaçant pour l'astreinte du ${dateLongue((d as any).date)}. Si vous êtes disponible, ouvrez l'appli, onglet « Échanges ».`;
    const sujet = estEchange ? 'Semaine d\'astreinte à reprendre' : 'Remplaçant d\'astreinte recherché';
    for (const a of agents ?? []) {
      if (a.id === d.agent_demandeur_id || !a.actif || !a.email || a.role === 'lecteur'
          || a.eligible_astreinte === false || a.categorie === 'communal') continue;
      messages.push({ email: a.email, nom: a.nom, sujet, texte });
    }
  } else {
    return json({ erreur: 'Requête invalide.' }, 400);
  }

  let envoyes = 0; const echecs: string[] = [];
  for (const m of messages) {
    try { await envoyer(m.email, m.nom, m.sujet, m.texte); envoyes++; }
    catch (e) { echecs.push(`${m.nom} : ${e}`); console.error(e); }
  }
  return json({ envoyes, echecs }, echecs.length ? 500 : 200);
});
