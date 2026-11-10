// Edge Function « sauvegarde » — Planning Astreinte Pasly
//
// Exporte toutes les données de l'appli :
//   - un fichier Excel lisible (un onglet par table + un onglet « Lisez-moi ») ;
//   - un fichier JSON exact, qui permet une restauration fidèle.
//
// Deux usages :
//   - tâche programmée (clé service_role), le 1er de chaque mois :
//     envoi des deux fichiers par email (Brevo) à DESTINATAIRE ;
//   - bouton de l'onglet Agents (administrateur connecté) :
//     renvoie le fichier demandé ({ format: 'xlsx' | 'json' }) pour téléchargement.
//
// Ne sont PAS exportés : les secrets et données techniques (clés des alertes,
// liens d'agenda, accès externes, abonnements des téléphones, notifications,
// mémoire des rappels). Le code est déjà sur GitHub.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import * as XLSX from 'https://esm.sh/xlsx@0.18.5';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const BREVO_API_KEY = Deno.env.get('BREVO_API_KEY') ?? '';
const SENDER_EMAIL = Deno.env.get('BREVO_SENDER_EMAIL') ?? '';
const DESTINATAIRE = 'lieveauxfrancois@gmail.com';

// Ordre = ordre de restauration (les tables référencées d'abord).
const TABLES = [
  'agents', 'semaines', 'planning', 'disponibilites', 'indisponibilites_periodes',
  'echanges', 'remplacements_jour', 'evenements', 'evenements_agents', 'evenements_reponses',
  'horaires_recurrents', 'planning_agents', 'planning_agents_historique'
];

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};
const json = (corps: unknown, status = 200) =>
  new Response(JSON.stringify(corps), { status, headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' } });

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

function enBase64(octets: Uint8Array): string {
  let s = '';
  for (let i = 0; i < octets.length; i += 0x8000) s += String.fromCharCode(...octets.subarray(i, i + 0x8000));
  return btoa(s);
}

async function lireTout(sb: ReturnType<typeof createClient>) {
  const donnees: Record<string, unknown[]> = {};
  for (const t of TABLES) {
    const lignes: unknown[] = [];
    for (let debut = 0; ; debut += 1000) {
      const { data, error } = await sb.from(t).select('*').range(debut, debut + 999);
      if (error) throw new Error(`${t} : ${error.message}`);
      lignes.push(...(data ?? []));
      if (!data || data.length < 1000) break;
    }
    donnees[t] = lignes;
  }
  return donnees;
}

function classeur(donnees: Record<string, unknown[]>, horodatage: string): Uint8Array {
  const wb = XLSX.utils.book_new();
  const lisezMoi = [
    ['Sauvegarde — Pasly RH & Planning'],
    ['Date', horodatage],
    [],
    ['Table', 'Lignes'],
    ...TABLES.map(t => [t, donnees[t].length]),
    [],
    ['Données personnelles (noms, téléphones, emails) : à conserver en lieu sûr.'],
    ['Pour une restauration, utiliser le fichier .json joint (copie exacte).']
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(lisezMoi), 'Lisez-moi');
  for (const t of TABLES) {
    // Les colonnes complexes (listes, objets) sont écrites en texte.
    const lignes = (donnees[t] as Record<string, unknown>[]).map(l =>
      Object.fromEntries(Object.entries(l).map(([k, v]) => [k, v !== null && typeof v === 'object' ? JSON.stringify(v) : v])));
    const feuille = lignes.length ? XLSX.utils.json_to_sheet(lignes) : XLSX.utils.aoa_to_sheet([['(vide)']]);
    XLSX.utils.book_append_sheet(wb, feuille, t.slice(0, 31));
  }
  return new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }));
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ erreur: 'Méthode non autorisée.' }, 405);

  const sb = createClient(SUPABASE_URL, SERVICE_KEY);
  const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  const estServeur = await estCleServeur(jwt);
  if (!estServeur) {
    const { data: u, error } = await sb.auth.getUser(jwt);
    if (error || !u?.user?.email) return json({ erreur: 'Connexion requise.' }, 401);
    const { data: a } = await sb.from('agents').select('role, actif').ilike('email', u.user.email).maybeSingle();
    if (!a || !a.actif || a.role !== 'admin') return json({ erreur: 'Réservé aux administrateurs.' }, 403);
  }
  const corps = await req.json().catch(() => ({}));

  const maintenant = new Date();
  const horodatage = maintenant.toLocaleString('fr-FR', { timeZone: 'Europe/Paris' });
  const jour = maintenant.toLocaleDateString('sv-SE', { timeZone: 'Europe/Paris' });
  let donnees: Record<string, unknown[]>;
  try { donnees = await lireTout(sb); } catch (e) { return json({ erreur: String(e) }, 500); }

  const xlsx = classeur(donnees, horodatage);
  const brut = new TextEncoder().encode(JSON.stringify({ application: 'Pasly RH & Planning', date: maintenant.toISOString(), tables: donnees }, null, 1));
  const nomXlsx = `sauvegarde-planning-pasly-${jour}.xlsx`;
  const nomJson = `sauvegarde-planning-pasly-${jour}.json`;
  const resume = TABLES.map(t => `${t} : ${donnees[t].length}`).join(' · ');

  // Bouton admin : renvoie le fichier demandé.
  if (!estServeur || corps.format) {
    if (corps.format === 'json') return json({ nom: nomJson, base64: enBase64(brut), resume });
    if (corps.format === 'xlsx' || !estServeur) return json({ nom: nomXlsx, base64: enBase64(xlsx), resume });
  }

  // Tâche programmée : envoi par email.
  if (!BREVO_API_KEY || !SENDER_EMAIL) return json({ erreur: 'Envoi d\'emails non configuré.' }, 500);
  if (corps.test) return json({ test: true, destinataire: DESTINATAIRE, resume, taille_xlsx: xlsx.length, taille_json: brut.length });
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': BREVO_API_KEY, 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({
      sender: { name: 'Commune de Pasly — Astreintes', email: SENDER_EMAIL },
      to: [{ email: DESTINATAIRE }],
      subject: `Sauvegarde mensuelle — Planning Astreinte (${jour})`,
      textContent: `Sauvegarde automatique du ${horodatage}.\n\n${resume}\n\n` +
        `Le fichier Excel est lisible directement ; le fichier « -json.txt » (format JSON) sert à une restauration exacte.\n` +
        `Ces fichiers contiennent des données personnelles : conservez-les en lieu sûr.`,
      attachment: [
        { name: nomXlsx, content: enBase64(xlsx) },
        // Brevo refuse l'extension .json : même contenu, en .txt.
        { name: nomJson.replace(/\.json$/, '-json.txt'), content: enBase64(brut) }
      ]
    })
  });
  if (!res.ok) return json({ erreur: `Brevo ${res.status} : ${await res.text()}` }, 500);
  return json({ envoye: true, destinataire: DESTINATAIRE, resume });
});
