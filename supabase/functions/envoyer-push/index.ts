// Edge Function « envoyer-push » — Planning Astreinte Pasly
//
// Envoie une alerte (notification push) sur les téléphones abonnés.
// Appelée uniquement par la base (déclencheur sur la table notifications),
// avec la clé service_role :
//   { notification_id }  → alerte au destinataire de cette notification ;
//   { action: 'init' }   → crée les clés VAPID du serveur si besoin.
// Les abonnements expirés (téléphone désinstallé…) sont supprimés d'office.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { genererClesVapid, envoyerPush } from './webpush.js';

const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
const SUJET = 'mailto:lieveauxfrancois@gmail.com'; // contact demandé par les services d'alerte

const json = (corps: unknown, status = 200) =>
  new Response(JSON.stringify(corps), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });

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
function estAppelServeur(req: Request): Promise<boolean> {
  return estCleServeur((req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, ''));
}

async function clesVapid(creer: boolean) {
  let { data } = await sb.from('push_config').select('cle_publique, cle_privee').eq('id', 1).maybeSingle();
  if (!data && creer) {
    const k = await genererClesVapid();
    await sb.from('push_config').insert({ id: 1, cle_publique: k.clePublique, cle_privee: k.jwkPrive });
    ({ data } = await sb.from('push_config').select('cle_publique, cle_privee').eq('id', 1).maybeSingle());
  }
  return data ? { clePublique: data.cle_publique, jwkPrive: data.cle_privee, sujet: SUJET } : null;
}

Deno.serve(async (req) => {
  if (!(await estAppelServeur(req))) return json({ erreur: 'Accès refusé.' }, 403);
  const corps = await req.json().catch(() => ({}));

  if (corps.action === 'init') {
    const v = await clesVapid(true);
    return json({ pret: !!v });
  }
  if (!corps.notification_id) return json({ erreur: 'Requête invalide.' }, 400);

  const { data: n } = await sb.from('notifications').select('id, agent_id, type, message, contexte')
    .eq('id', corps.notification_id).maybeSingle();
  if (!n) return json({ ignore: 'notification introuvable' });
  const { data: abonnements } = await sb.from('push_abonnements').select('endpoint, p256dh, auth').eq('agent_id', n.agent_id);
  if (!abonnements?.length) return json({ ignore: 'aucun téléphone abonné' });
  const vapid = await clesVapid(false);
  if (!vapid) return json({ erreur: 'Clés du serveur absentes.' }, 500);

  const message = {
    title: 'Pasly RH & Planning',
    body: n.message,
    tag: n.id,
    tab: n.contexte?.tab ?? null,
    semaine_id: n.contexte?.semaine_id ?? null
  };

  let envoyes = 0, supprimes = 0;
  const erreurs: string[] = [];
  for (const a of abonnements) {
    try {
      const res = await envoyerPush(a, message, vapid);
      if (res.ok) {
        envoyes++;
        await sb.from('push_abonnements').update({ dernier_envoi: new Date().toISOString() }).eq('endpoint', a.endpoint);
      } else if (res.status === 404 || res.status === 410) {
        // Abonnement expiré : on le retire.
        await sb.from('push_abonnements').delete().eq('endpoint', a.endpoint);
        supprimes++;
      } else {
        erreurs.push(`${new URL(a.endpoint).host} ${res.status} ${(await res.text()).slice(0, 200)}`);
      }
    } catch (e) {
      erreurs.push(String(e));
    }
  }
  if (erreurs.length) console.error('Alertes non envoyées :', erreurs);
  return json({ envoyes, supprimes, erreurs }, erreurs.length && !envoyes ? 500 : 200);
});
