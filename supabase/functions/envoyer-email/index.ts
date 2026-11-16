// Edge Function « envoyer-email » — Planning Astreinte Pasly
//
// Emails déclenchés depuis l'appli (remplace EmailJS) :
//   { action: 'publication', semaine_id }  → agent désigné de la semaine (admin)
//   { action: 'relance',     semaine_id }  → agents éligibles n'ayant pas répondu (admin) ;
//   { action: 'relance',     semaine_ids } → idem pour plusieurs semaines d'un coup : chaque agent
//                                            reçoit UN SEUL email listant les semaines qu'il lui
//                                            reste à déclarer (plusieurs emails presque identiques
//                                            à la même minute finissent dans les indésirables) ;
//                                            crée aussi une notification (cloche + alerte téléphone),
//                                            une seule par personne en 15 minutes
//   { action: 'evenement',   evenement_id } → participants désignés (admin ou gestion événements)
//
// Sécurité : l'appli n'envoie que des identifiants. Destinataires et textes
// sont déterminés ICI, à partir de la base : impossible de s'en servir pour
// envoyer un message libre à une adresse quelconque. L'appelant doit être
// connecté, actif, et avoir le droit correspondant à l'action.
//
// Garde-fou : au plus 5 envois par heure pour une même semaine ou un même
// événement (un bouton sollicité en boucle ne peut pas inonder les boîtes).
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
const dateCourte = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
function echapper(s: string): string {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

// Lien qui ouvre l'appli directement sur l'onglet « Mes disponibilités », à la
// semaine concernée (mêmes paramètres que les alertes du téléphone).
const lienDispos = (semaineId: string) => `${APP_URL}?onglet=dispos&semaine=${encodeURIComponent(semaineId)}`;

// `liste` : lignes affichées en liste à puces sous le texte (relance groupée).
// `lien` : adresse ouverte par le lien du message (par défaut, l'accueil de l'appli).
async function envoyer(email: string, nom: string, sujet: string, texte: string, liste: string[] = [], lien: string = APP_URL): Promise<void> {
  const html = `<p>Bonjour ${echapper(nom)},</p><p>${echapper(texte)}</p>` +
    (liste.length ? `<ul>${liste.map(l => `<li>${echapper(l)}</li>`).join('')}</ul>` : '') +
    `<p><a href="${echapper(lien)}">${lien === APP_URL ? 'Ouvrir le planning des astreintes' : 'Déclarer ma disponibilité'}</a></p>` +
    `<p style="color:#777;font-size:12px">Message automatique — Commune de Pasly.</p>`;
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': BREVO_API_KEY, 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({
      sender: { name: SENDER_NAME, email: SENDER_EMAIL },
      to: [{ email, name: nom }],
      subject: sujet,
      htmlContent: html,
      textContent: `Bonjour ${nom},\n\n${texte}\n${liste.map(l => `- ${l}\n`).join('')}\n${lien}`
    })
  });
  if (!res.ok) throw new Error(`Brevo ${res.status} : ${await res.text()}`);
}

// Appel « serveur » (tâche programmée, déclencheur de la base) : le jeton
// présenté doit être une vraie clé de service. Lire le rôle inscrit dans le
// jeton ne prouve rien à lui seul (n'importe qui peut écrire « service_role »
// dans un faux jeton) : la clé est donc comparée à celle du serveur et, si
// elle diffère (ancienne clé encore valide…), validée auprès de Supabase.
// La fonction reste ainsi protégée même si la vérification des jetons en
// amont (« verify_jwt ») était un jour désactivée lors d'un déploiement.
function roleDuJeton(jwt: string): string | null {
  try { return JSON.parse(atob(jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).role ?? null; }
  catch { return null; }
}
function egal(a: string, b: string): boolean {               // comparaison à durée constante
  if (a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
async function estCleServeur(jwt: string): Promise<boolean> {
  const url = Deno.env.get('SUPABASE_URL') ?? '';
  const cle = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  if (!jwt) return false;
  if (cle && egal(jwt, cle)) return true;
  if (roleDuJeton(jwt) !== 'service_role') return false;
  try {
    const r = await fetch(`${url}/auth/v1/admin/users?page=1&per_page=1`, { headers: { apikey: jwt, Authorization: `Bearer ${jwt}` } });
    await r.body?.cancel();
    return r.ok;
  } catch { return false; }
}

type Message = { email: string; nom: string; sujet: string; texte: string; liste?: string[]; lien?: string };

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return reponse({ erreur: 'Méthode non autorisée.' }, 405);

  const sb = createClient(SUPABASE_URL, SERVICE_KEY);
  const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  const estServeur = await estCleServeur(jwt);

  // ---- Qui appelle ? ----
  let appelant: { id: string; role: string; actif: boolean; peut_gerer_evenements: boolean } | null = null;
  if (!estServeur) {
    const { data: u, error } = await sb.auth.getUser(jwt);
    if (error || !u?.user?.email) return reponse({ erreur: 'Connexion requise.' }, 401);
    const { data: a } = await sb.from('agents').select('id, role, actif, peut_gerer_evenements')
      .eq('email', u.user.email.toLowerCase()).maybeSingle();   // adresses toujours en minuscules en base
    if (!a || !a.actif) return reponse({ erreur: 'Compte non autorisé.' }, 403);
    appelant = a;
  }
  const estAdmin = estServeur || appelant?.role === 'admin';
  const gereEvenements = estAdmin || !!appelant?.peut_gerer_evenements;

  let corps: { action?: string; semaine_id?: string; semaine_ids?: string[]; evenement_id?: string; test?: boolean };
  try { corps = await req.json(); } catch { return reponse({ erreur: 'Requête invalide.' }, 400); }
  const test = estServeur && corps.test === true;
  if (!test && (!BREVO_API_KEY || !SENDER_EMAIL)) return reponse({ erreur: 'Envoi d\'emails non configuré sur le serveur.' }, 500);

  const messages: Message[] = [];
  // Relance : semaines restant à déclarer, agent par agent (pour la notification).
  let relance: Map<string, any[]> | null = null;
  // Éléments concernés par l'envoi (garde-fou « 5 envois par heure »).
  let cibles: string[] = [];

  if (corps.action === 'publication') {
    if (!estAdmin) return reponse({ erreur: 'Réservé aux administrateurs.' }, 403);
    const { data: s } = await sb.from('semaines').select('*').eq('id', corps.semaine_id ?? '').maybeSingle();
    if (!s) return reponse({ erreur: 'Semaine introuvable.' }, 404);
    if (s.statut !== 'publiee') return reponse({ erreur: 'Cette semaine n\'est pas publiée.' }, 409);
    const { data: p } = await sb.from('planning').select('agent_id').eq('semaine_id', s.id).maybeSingle();
    const { data: a } = p ? await sb.from('agents').select('nom, email, actif').eq('id', p.agent_id).maybeSingle() : { data: null };
    if (!a || !a.actif || !a.email) return reponse({ erreur: 'Aucun agent joignable pour cette semaine.' }, 409);
    cibles = [s.id];
    messages.push({ email: a.email, nom: a.nom, sujet: 'Vous êtes d\'astreinte',
      texte: `Vous êtes désigné(e) d'astreinte pour la semaine du ${dateLongue(s.date_debut)} au ${dateLongue(s.date_fin)}.` });

  } else if (corps.action === 'relance') {
    if (!estAdmin) return reponse({ erreur: 'Réservé aux administrateurs.' }, 403);
    const plusieurs = Array.isArray(corps.semaine_ids);
    const demandees = [...new Set((plusieurs ? corps.semaine_ids! : [corps.semaine_id ?? ''])
      .filter(id => typeof id === 'string' && id))];
    if (!demandees.length || demandees.length > 60) return reponse({ erreur: 'Requête invalide.' }, 400);
    const { data: trouvees } = await sb.from('semaines').select('*').in('id', demandees).order('date_debut');
    if (!trouvees?.length) return reponse({ erreur: 'Semaine introuvable.' }, 404);
    // Plusieurs semaines demandées : celles qui ne sont plus ouvertes sont simplement ignorées.
    const ouvertes = trouvees.filter(s => s.statut === 'ouverte');
    if (!ouvertes.length) return reponse({ erreur: plusieurs
      ? 'Aucune de ces semaines n\'est ouverte aux disponibilités.'
      : 'Cette semaine n\'est plus ouverte aux disponibilités.' }, 409);
    const [{ data: agents }, { data: dispos }] = await Promise.all([
      sb.from('agents').select('id, nom, email, role, actif, eligible_astreinte, categorie'),
      sb.from('disponibilites').select('semaine_id, agent_id').in('semaine_id', ouvertes.map(s => s.id))
    ]);
    const aRepondu = new Set((dispos ?? []).map(d => d.semaine_id + '|' + d.agent_id));
    relance = new Map();
    cibles = ouvertes.map(s => s.id);
    for (const a of agents ?? []) {
      if (!a.actif || !a.email || a.role === 'lecteur' || a.eligible_astreinte === false || a.categorie === 'communal') continue;
      const aFaire = ouvertes.filter(s => !aRepondu.has(s.id + '|' + a.id));
      if (!aFaire.length) continue;
      relance.set(a.id, aFaire);
      if (aFaire.length === 1) {
        const s = aFaire[0];
        messages.push({ email: a.email, nom: a.nom, sujet: 'Rappel — Déclarez votre disponibilité', lien: lienDispos(s.id),
          texte: `Merci de déclarer votre disponibilité pour la semaine du ${dateLongue(s.date_debut)} au ${dateLongue(s.date_fin)}, avant le ${dateLongue(s.date_limite_dispo)}.` });
      } else {
        // Un seul email, toutes les semaines restant à déclarer.
        messages.push({ email: a.email, nom: a.nom, sujet: 'Rappel — Déclarez vos disponibilités', lien: lienDispos(aFaire[0].id),
          texte: `Merci de déclarer votre disponibilité pour les ${aFaire.length} semaines suivantes :`,
          liste: aFaire.map(s => `du ${dateLongue(s.date_debut)} au ${dateLongue(s.date_fin)} — à déclarer avant le ${dateLongue(s.date_limite_dispo)}`) });
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
      cibles = [ev.id];
      messages.push({ email: a.email, nom: a.nom, sujet: `Vous êtes désigné(e) — ${ev.intitule}`,
        texte: `Vous êtes désigné(e) comme participant pour : ${ev.intitule}, le ${dateLongue(ev.date)}` +
          `${ev.heure ? ' à ' + ev.heure : ''}${ev.lieu ? ' (' + ev.lieu + ')' : ''}.` });
    }
  } else {
    return reponse({ erreur: 'Action inconnue.' }, 400);
  }

  if (test) return reponse({ test: true, envoyes: 0, prevus: messages.map(m => ({ a: m.nom, sujet: m.sujet, semaines: m.liste?.length ?? undefined })) });

  // Garde-fou : au plus 5 envois par heure pour une même semaine ou un même événement.
  if (messages.length) {
    const prefixe = `envoi|${corps.action}|`;
    const ilYa1h = new Date(Date.now() - 3600000).toISOString();
    const { data: recents } = await sb.from('rappels_envoyes').select('cle')
      .like('cle', prefixe + '%').gte('envoye_le', ilYa1h);
    const trop = cibles.some(c => (recents ?? []).filter(r => r.cle.startsWith(prefixe + c + '|')).length >= 5);
    if (trop) return reponse({ erreur: 'Trop d\'envois en une heure pour cet élément : réessayez plus tard.' }, 429);
    const maintenant = Date.now();
    await sb.from('rappels_envoyes').insert(cibles.map(c => ({ cle: prefixe + c + '|' + maintenant })));
  }

  // Relance : notification (cloche + alerte téléphone), sauf si la personne
  // en a déjà reçu une non lue il y a moins de 15 minutes.
  if (relance && relance.size) {
    const ids = [...relance.keys()];
    const il15min = new Date(Date.now() - 15 * 60000).toISOString();
    const { data: recentes } = await sb.from('notifications').select('agent_id')
      .eq('type', 'disponibilite_demandee').eq('lue', false).gte('created_at', il15min).in('agent_id', ids);
    const dejaPrevenus = new Set((recentes ?? []).map(n => n.agent_id));
    const lignes = ids.filter(id => !dejaPrevenus.has(id)).map(id => {
      const aFaire = relance!.get(id)!;
      const s = aFaire[0];                                        // la plus proche
      const limite = aFaire.map(x => x.date_limite_dispo).sort()[0];
      return {
        agent_id: id, type: 'disponibilite_demandee',
        message: aFaire.length === 1
          ? `🗓️ Disponibilité à déclarer : semaine du ${dateCourte(s.date_debut)} au ${dateCourte(s.date_fin)}, avant le ${dateCourte(s.date_limite_dispo)}.`
          : `🗓️ Disponibilités à déclarer pour ${aFaire.length} semaines, à partir de celle du ${dateCourte(s.date_debut)}. Première date limite : ${dateCourte(limite)}.`,
        contexte: { tab: 'dispos', semaine_id: s.id }
      };
    });
    if (lignes.length) {
      const { error } = await sb.from('notifications').insert(lignes);
      if (error) console.error('Notifications de relance non créées', error);
    }
  }

  let envoyes = 0; const echecs: string[] = [];
  for (const m of messages) {
    try { await envoyer(m.email, m.nom, m.sujet, m.texte, m.liste, m.lien); envoyes++; }
    catch (e) { echecs.push(`${m.nom} : ${e}`); console.error(e); }
  }
  return reponse({ envoyes, echecs: echecs.length });
});
