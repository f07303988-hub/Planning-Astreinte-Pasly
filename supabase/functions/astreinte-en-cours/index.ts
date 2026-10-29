// Edge Function « astreinte-en-cours » — Planning Astreinte Pasly
//
// Donne au carnet de bord « Pasly Astreinte » (téléphones d'astreinte) qui est
// d'astreinte aujourd'hui, cette semaine et la semaine suivante, avec le téléphone.
// Ainsi que la liste des élus (nom, téléphone) pour créer les utilisateurs du carnet.
//
//   GET .../functions/v1/astreinte-en-cours?t=<code secret>
//
// Le code secret (table acces_externes, nom « carnet_astreinte ») n'est connu que
// du serveur de la mairie, qui ne le donne qu'aux comptes administrateur ou
// contributeur des téléphones d'astreinte. Déployée sans vérification JWT : le
// carnet est connecté à un autre projet Supabase ; c'est le code qui protège l'accès.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
const ORIGINE = 'https://f07303988-hub.github.io';
const CORS = { 'Access-Control-Allow-Origin': ORIGINE, 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': 'content-type', 'Vary': 'Origin' };
const json = (corps: unknown, status = 200) =>
  new Response(JSON.stringify(corps), { status, headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });

function aujourdhuiParis(): string { return new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Paris' }); }
function ajouterJours(iso: string, n: number): string { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function egal(a: string, b: string): boolean {               // comparaison à durée constante
  if (a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'GET') return json({ erreur: 'Méthode non autorisée.' }, 405);
  const t = new URL(req.url).searchParams.get('t') ?? '';
  if (!/^[0-9a-f]{48}$/.test(t)) return json({ erreur: 'Accès refusé.' }, 403);
  const { data: acces } = await sb.from('acces_externes').select('jeton').eq('nom', 'carnet_astreinte').maybeSingle();
  if (!acces || !egal(acces.jeton, t)) return json({ erreur: 'Accès refusé.' }, 403);

  const jour = aujourdhuiParis();
  const { data: semaines, error } = await sb.from('semaines').select('id, date_debut, date_fin, statut')
    .eq('statut', 'publiee').gte('date_fin', jour).lte('date_debut', ajouterJours(jour, 14)).order('date_debut').limit(3);
  if (error) return json({ erreur: error.message }, 500);
  const ids = (semaines ?? []).map(s => s.id);
  const [{ data: plan }, { data: rempl }, { data: agents }] = await Promise.all([
    ids.length ? sb.from('planning').select('semaine_id, agent_id').in('semaine_id', ids) : Promise.resolve({ data: [] as any[] }),
    sb.from('remplacements_jour').select('date, agent_demandeur_id, agent_remplacant_id').eq('statut', 'acceptee').gte('date', jour).lte('date', ajouterJours(jour, 1)),
    sb.from('agents').select('id, nom, telephone, actif, role, categorie'),
  ]);
  const agent = (id?: string | null) => { const a = (agents ?? []).find(x => x.id === id); return a ? { nom: a.nom, telephone: a.telephone ?? null } : null; };
  const semaine = (s: any) => s ? { debut: s.date_debut, fin: s.date_fin, titulaire: agent((plan ?? []).find(p => p.semaine_id === s.id)?.agent_id) } : null;

  const courante = (semaines ?? []).find(s => s.date_debut <= jour && s.date_fin >= jour) ?? null;
  const suivante = (semaines ?? []).find(s => s.date_debut > jour) ?? null;
  const remplAujourdhui = (rempl ?? []).find(r => r.date === jour);
  const sc = semaine(courante);
  return json({
    jour,
    aujourdhui: remplAujourdhui ? { ...agent(remplAujourdhui.agent_remplacant_id), remplace: agent(remplAujourdhui.agent_demandeur_id)?.nom ?? null } : (sc?.titulaire ?? null),
    semaine: sc,
    suivante: semaine(suivante),
    // Élus actifs (pour créer les utilisateurs du carnet) : nom et téléphone uniquement
    elus: (agents ?? []).filter(a => a.actif && (a.categorie ?? 'elu') === 'elu' && a.role !== 'lecteur')
      .map(a => ({ nom: a.nom, telephone: a.telephone ?? null })).sort((x, y) => x.nom.localeCompare(y.nom, 'fr')),
    demain_remplacement: (() => { const r = (rempl ?? []).find(x => x.date === ajouterJours(jour, 1)); return r ? { ...agent(r.agent_remplacant_id), remplace: agent(r.agent_demandeur_id)?.nom ?? null } : null; })(),
  });
});
