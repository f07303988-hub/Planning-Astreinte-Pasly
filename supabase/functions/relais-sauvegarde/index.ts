// Edge Function « relais-sauvegarde » — Planning Astreinte Pasly
//
// Envoie par email (Brevo) la sauvegarde mensuelle d'une AUTRE application de
// la mairie : « Bâtiments communaux » (projet Supabase « mairie-pasly »), qui
// n'a pas de service d'envoi. La clé Brevo reste ainsi dans ce seul projet.
//
// Sécurité :
//   - l'appelant présente un jeton (en-tête x-jeton-relais) connu de la seule
//     base « mairie-pasly » ; ce projet-ci n'en conserve que l'empreinte
//     SHA-256 (table acces_externes, nom « relais_sauvegarde_batiments ») ;
//   - le destinataire, l'objet et le texte sont fixés ICI : le relais ne peut
//     pas servir à écrire à une autre adresse ni à envoyer un message libre ;
//   - au plus 5 envois par jour, pièce jointe limitée à 15 Mo.
//
// Secrets : BREVO_API_KEY, BREVO_SENDER_EMAIL.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const BREVO_API_KEY = Deno.env.get('BREVO_API_KEY') ?? '';
const SENDER_EMAIL = Deno.env.get('BREVO_SENDER_EMAIL') ?? '';
const DESTINATAIRE = 'lieveauxfrancois@gmail.com';
const NOM_ACCES = 'relais_sauvegarde_batiments';
const MAX_PAR_JOUR = 5;
const MAX_BASE64 = 20_000_000;   // environ 15 Mo de fichier

const json = (corps: unknown, status = 200) =>
  new Response(JSON.stringify(corps), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });

async function sha256Hex(texte: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(texte)));
  return Array.from(d).map(b => b.toString(16).padStart(2, '0')).join('');
}
function egal(a: string, b: string): boolean {               // comparaison à durée constante
  if (a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
const texteCourt = (v: unknown, max: number) => String(v ?? '').replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, max);

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ erreur: 'Méthode non autorisée.' }, 405);
  const sb = createClient(SUPABASE_URL, SERVICE_KEY);

  // ---- Qui appelle ? ----
  const jeton = req.headers.get('x-jeton-relais') ?? '';
  const { data: acces } = await sb.from('acces_externes').select('jeton').eq('nom', NOM_ACCES).maybeSingle();
  if (!jeton || !acces?.jeton || !egal(await sha256Hex(jeton), acces.jeton)) return json({ erreur: 'Accès refusé.' }, 403);

  let corps: { test?: boolean; jour?: string; resume?: string; contenu_base64?: string };
  try { corps = await req.json(); } catch { return json({ erreur: 'Requête invalide.' }, 400); }
  if (corps.test === true) return json({ test: true, pret: !!(BREVO_API_KEY && SENDER_EMAIL), destinataire: DESTINATAIRE });
  if (!BREVO_API_KEY || !SENDER_EMAIL) return json({ erreur: 'Envoi d\'emails non configuré.' }, 500);

  const jour = /^\d{4}-\d{2}-\d{2}$/.test(corps.jour ?? '') ? corps.jour! : new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Paris' });
  const contenu = corps.contenu_base64 ?? '';
  if (!contenu || contenu.length > MAX_BASE64 || !/^[A-Za-z0-9+/]+=*$/.test(contenu)) return json({ erreur: 'Pièce jointe absente, invalide ou trop volumineuse.' }, 400);
  const resume = texteCourt(corps.resume, 1500) || 'Résumé non fourni.';

  // ---- Limite d'envois par jour ----
  const aujourdhui = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Paris' });
  const prefixe = `relais-sauvegarde|${aujourdhui}|`;
  const { count } = await sb.from('rappels_envoyes').select('cle', { count: 'exact', head: true }).like('cle', prefixe + '%');
  if ((count ?? 0) >= MAX_PAR_JOUR) return json({ erreur: 'Trop d\'envois aujourd\'hui : réessayez demain.' }, 429);
  await sb.from('rappels_envoyes').insert({ cle: prefixe + Date.now() });

  const horodatage = new Date().toLocaleString('fr-FR', { timeZone: 'Europe/Paris' });
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': BREVO_API_KEY, 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({
      sender: { name: 'Commune de Pasly — Bâtiments', email: SENDER_EMAIL },
      to: [{ email: DESTINATAIRE }],
      subject: `Sauvegarde — Bâtiments communaux (${jour})`,
      textContent: `Sauvegarde automatique des données de l'application « Bâtiments communaux », reçue le ${horodatage}.\n\n${resume}\n\n` +
        `Le fichier joint (format JSON) permet de restaurer les données. Il ne contient pas les fichiers (PDF, photos), ` +
        `dont il donne seulement la liste, ni les comptes.\n` +
        `Il contient des données personnelles : conservez-le en lieu sûr et supprimez les copies de plus d'un an.`,
      // Brevo refuse l'extension .json : même contenu, en .txt.
      attachment: [{ name: `sauvegarde-batiments-pasly-${jour}-json.txt`, content: contenu }]
    })
  });
  if (!res.ok) return json({ erreur: `Brevo ${res.status} : ${(await res.text()).slice(0, 300)}` }, 502);
  return json({ envoye: true, destinataire: DESTINATAIRE });
});
