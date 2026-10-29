// Edge Function « creer-acces » — Planning Astreinte Pasly
//
// Les inscriptions libres sont fermées : un élu ne peut plus créer son compte
// lui-même lors de sa première connexion. Cette fonction, réservée aux
// administrateurs, crée le compte de connexion des agents (élus / secrétariat)
// qui ont une adresse email sur leur fiche mais pas encore de compte, puis leur
// envoie un email d'accueil. Ils se connectent ensuite comme les autres, avec
// le lien reçu par email.
//
//   { agent_id }  → uniquement cet agent
//   { agent_id, ancien_email } → l'adresse de la fiche a changé : le compte existant
//                    prend la nouvelle adresse (pas de second compte en double)
//   {}            → tous les agents actifs concernés
//   { test:true } → liste ce qui serait fait, sans rien créer ni envoyer
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
const reponse = (corps: unknown, status = 200) =>
  new Response(JSON.stringify(corps), { status, headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' } });
const echapper = (s: string) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

async function accueil(email: string, nom: string): Promise<void> {
  const texte = `Votre accès au planning des astreintes de la commune de Pasly est prêt.\n\n` +
    `Pour vous connecter : ouvrez ${APP_URL}, saisissez votre adresse (${email}) sans mot de passe, ` +
    `puis cliquez sur le lien que vous recevrez par email.`;
  const html = `<p>Bonjour ${echapper(nom)},</p><p>Votre accès au planning des astreintes de la commune de Pasly est prêt.</p>` +
    `<p>Pour vous connecter : ouvrez l'application, saisissez votre adresse <b>${echapper(email)}</b> sans mot de passe, puis cliquez sur le lien que vous recevrez par email.</p>` +
    `<p><a href="${APP_URL}">Ouvrir le planning des astreintes</a></p>` +
    `<p style="color:#777;font-size:12px">Message automatique — Commune de Pasly.</p>`;
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': BREVO_API_KEY, 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({ sender: { name: SENDER_NAME, email: SENDER_EMAIL }, to: [{ email, name: nom }],
      subject: 'Votre accès au planning des astreintes', htmlContent: html, textContent: `Bonjour ${nom},\n\n${texte}` })
  });
  if (!res.ok) throw new Error(`Brevo ${res.status} : ${await res.text()}`);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return reponse({ erreur: 'Méthode non autorisée.' }, 405);
  const sb = createClient(SUPABASE_URL, SERVICE_KEY);

  // Appelant : administrateur actif uniquement
  const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  const { data: u, error: eu } = await sb.auth.getUser(jwt);
  if (eu || !u?.user?.email) return reponse({ erreur: 'Connexion requise.' }, 401);
  const { data: moi } = await sb.from('agents').select('role, actif').ilike('email', u.user.email).maybeSingle();
  if (!moi || !moi.actif || moi.role !== 'admin') return reponse({ erreur: 'Réservé aux administrateurs.' }, 403);

  let corps: { agent_id?: string; ancien_email?: string; test?: boolean } = {};
  try { corps = await req.json(); } catch { /* corps vide accepté */ }

  let q = sb.from('agents').select('id, nom, email, actif, categorie').eq('actif', true).eq('categorie', 'elu').not('email', 'is', null);
  if (corps.agent_id) q = q.eq('id', corps.agent_id);
  const { data: agents, error: ea } = await q;
  if (ea) return reponse({ erreur: ea.message }, 500);

  // Comptes existants (comparaison sans tenir compte des majuscules)
  const existants = new Map<string, string>();
  for (let page = 1; ; page++) {
    const { data, error } = await sb.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) return reponse({ erreur: error.message }, 500);
    data.users.forEach(x => x.email && existants.set(x.email.toLowerCase(), x.id));
    if (data.users.length < 1000) break;
  }
  // Changement d'adresse : le compte de l'ancienne adresse est déplacé vers la nouvelle
  const ancien = String(corps.ancien_email ?? '').trim().toLowerCase();
  const deplaces: string[] = [];
  if (corps.agent_id && ancien && existants.has(ancien)) {
    const a = (agents ?? [])[0];
    const nouvelle = String(a?.email ?? '').trim().toLowerCase();
    if (a && nouvelle && nouvelle !== ancien && !existants.has(nouvelle)) {
      // L'ancienne adresse ne doit plus être celle d'une autre fiche
      const { data: autre } = await sb.from('agents').select('id').ilike('email', ancien).maybeSingle();
      if (!autre) {
        if (corps.test) return reponse({ test: true, deplace: `${ancien} → ${nouvelle}` });
        const { error } = await sb.auth.admin.updateUserById(existants.get(ancien)!, { email: nouvelle, email_confirm: true });
        if (error) return reponse({ crees: [], echecs: [`${a.nom} : ${error.message}`] }, 207);
        existants.delete(ancien); existants.set(nouvelle, 'deplace'); deplaces.push(a.nom);
      }
    }
  }
  const aCreer = (agents ?? []).filter(a => a.email && !existants.has(a.email.toLowerCase()));
  if (corps.test) return reponse({ test: true, a_creer: aCreer.map(a => a.nom) });
  if (aCreer.length && (!BREVO_API_KEY || !SENDER_EMAIL)) return reponse({ erreur: 'Envoi d\'emails non configuré sur le serveur.' }, 500);

  const crees: string[] = [], echecs: string[] = [], sansEmail: string[] = [];
  for (const a of aCreer) {
    const { error } = await sb.auth.admin.createUser({ email: a.email, email_confirm: true, user_metadata: { nom: a.nom } });
    if (error && !/already|registered|exists/i.test(error.message)) { echecs.push(`${a.nom} : ${error.message}`); continue; }
    crees.push(a.nom);
    try { await accueil(a.email, a.nom); } catch (e) { sansEmail.push(a.nom); console.error(e); }
  }
  return reponse({ crees, deplaces, echecs, email_non_envoye: sansEmail }, echecs.length ? 207 : 200);
});
