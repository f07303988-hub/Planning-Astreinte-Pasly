// Edge Function « agenda-ics » — Planning Astreinte Pasly
//
// Agenda personnel au format iCalendar (.ics), auquel l'élu s'abonne depuis
// son téléphone (Calendrier iPhone, Google Agenda…). Le téléphone relit
// régulièrement cette adresse : l'agenda se met à jour tout seul.
//
//   GET .../functions/v1/agenda-ics?t=<code secret personnel>
//
// Contenu : ses semaines d'astreinte publiées, ses remplacements d'un jour
// (dans les deux sens) et les événements de mairie où il est désigné (sauf
// s'il a répondu « absent »). Aucun téléphone ni email d'autrui.
// Code inconnu ou agent désactivé → 404.
// Déployée sans vérification JWT : les applis d'agenda ne savent pas s'identifier,
// c'est le code secret (48 caractères aléatoires) qui protège l'accès.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
const APP_URL = 'https://f07303988-hub.github.io/Planning-Astreinte-Pasly/';
const HISTORIQUE_JOURS = 60; // on garde 2 mois passés dans l'agenda

// ---------- Outils iCalendar ----------
function echapper(s: string): string {
  return String(s ?? '').replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/([,;])/g, '\\$1');
}
// Coupe les lignes à 75 octets (règle du format), en respectant l'UTF-8.
function plier(ligne: string): string {
  const enc = new TextEncoder();
  if (enc.encode(ligne).length <= 75) return ligne;
  const morceaux: string[] = []; let courant = ''; let taille = 0;
  for (const c of ligne) {
    const t = enc.encode(c).length;
    if (taille + t > (morceaux.length ? 74 : 75)) { morceaux.push(courant); courant = ''; taille = 0; }
    courant += c; taille += t;
  }
  morceaux.push(courant);
  return morceaux.join('\r\n ');
}
const dateIcs = (iso: string) => iso.replace(/-/g, '');
function lendemain(iso: string): string {
  const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
// « 14h30 », « 14h », « 14:30 » → « 143000 » ; sinon null.
function heureIcs(h: string | null): string | null {
  const m = String(h ?? '').trim().match(/^(\d{1,2})\s*[h:]\s*(\d{0,2})$/i);
  if (!m) return null;
  const hh = parseInt(m[1], 10), mm = m[2] ? parseInt(m[2], 10) : 0;
  if (hh > 23 || mm > 59) return null;
  return String(hh).padStart(2, '0') + String(mm).padStart(2, '0') + '00';
}
const horodatage = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

type Evt = { uid: string; titre: string; debut: string; fin: string; journee: boolean; lieu?: string; description?: string; rappelVeille?: boolean };

function vevent(e: Evt): string[] {
  const l = ['BEGIN:VEVENT', `UID:${e.uid}@astreintes.pasly`, `DTSTAMP:${horodatage()}`];
  if (e.journee) { l.push(`DTSTART;VALUE=DATE:${e.debut}`, `DTEND;VALUE=DATE:${e.fin}`); }
  else { l.push(`DTSTART;TZID=Europe/Paris:${e.debut}`, `DTEND;TZID=Europe/Paris:${e.fin}`); }
  l.push(`SUMMARY:${echapper(e.titre)}`);
  if (e.lieu) l.push(`LOCATION:${echapper(e.lieu)}`);
  l.push(`DESCRIPTION:${echapper((e.description ? e.description + '\n\n' : '') + APP_URL)}`);
  l.push('TRANSP:' + (e.journee ? 'TRANSPARENT' : 'OPAQUE'));
  if (e.rappelVeille) {
    // Journée entière : alarme la veille à 18 h.
    l.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${echapper(e.titre)}`, 'TRIGGER:-PT6H', 'END:VALARM');
  }
  l.push('END:VEVENT');
  return l;
}

const VTIMEZONE = [
  'BEGIN:VTIMEZONE', 'TZID:Europe/Paris',
  'BEGIN:DAYLIGHT', 'TZOFFSETFROM:+0100', 'TZOFFSETTO:+0200', 'TZNAME:CEST', 'DTSTART:19700329T020000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU', 'END:DAYLIGHT',
  'BEGIN:STANDARD', 'TZOFFSETFROM:+0200', 'TZOFFSETTO:+0100', 'TZNAME:CET', 'DTSTART:19701025T030000', 'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU', 'END:STANDARD',
  'END:VTIMEZONE'
];

Deno.serve(async (req) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return new Response('Méthode non autorisée', { status: 405 });
  const jeton = new URL(req.url).searchParams.get('t') ?? '';
  if (!/^[0-9a-f]{48}$/.test(jeton)) return new Response('Lien invalide', { status: 404 });

  const { data: j } = await sb.from('agenda_jetons').select('agent_id').eq('jeton', jeton).maybeSingle();
  if (!j) return new Response('Lien invalide', { status: 404 });
  const { data: moi } = await sb.from('agents').select('id, nom, actif').eq('id', j.agent_id).maybeSingle();
  if (!moi || !moi.actif) return new Response('Lien invalide', { status: 404 });

  const depuis = new Date(); depuis.setUTCDate(depuis.getUTCDate() - HISTORIQUE_JOURS);
  const depuisIso = depuis.toISOString().slice(0, 10);

  const [{ data: mesSemaines }, { data: rempl }, { data: liens }, { data: absences }, { data: agents }] = await Promise.all([
    sb.from('planning').select('semaine_id, semaines!inner(id, date_debut, date_fin, statut)')
      .eq('agent_id', moi.id).eq('semaines.statut', 'publiee').gte('semaines.date_fin', depuisIso),
    sb.from('remplacements_jour').select('id, date, agent_demandeur_id, agent_remplacant_id')
      .eq('statut', 'acceptee').gte('date', depuisIso)
      .or(`agent_demandeur_id.eq.${moi.id},agent_remplacant_id.eq.${moi.id}`),
    sb.from('evenements_agents').select('evenements!inner(id, type, date, heure, heure_fin, intitule, lieu, description)')
      .eq('agent_id', moi.id).gte('evenements.date', depuisIso),
    sb.from('evenements_reponses').select('evenement_id').eq('agent_id', moi.id).eq('reponse', 'absent'),
    sb.from('agents').select('id, nom')
  ]);
  const nom = (id: string) => (agents ?? []).find(a => a.id === id)?.nom ?? 'un agent';
  const absent = new Set((absences ?? []).map(a => a.evenement_id));

  const evts: Evt[] = [];
  for (const p of mesSemaines ?? []) {
    const s = (p as any).semaines;
    evts.push({
      uid: `astreinte-${s.id}`, titre: 'Astreinte Pasly', journee: true,
      debut: dateIcs(s.date_debut), fin: dateIcs(lendemain(s.date_fin)), rappelVeille: true,
      description: 'Semaine d\'astreinte de la commune de Pasly.'
    });
  }
  for (const r of rempl ?? []) {
    const jeRemplace = r.agent_remplacant_id === moi.id;
    evts.push({
      uid: `remplacement-${r.id}`, journee: true, rappelVeille: jeRemplace,
      titre: jeRemplace ? `Astreinte Pasly (remplacement de ${nom(r.agent_demandeur_id)})` : `Astreinte : remplacé(e) par ${nom(r.agent_remplacant_id)}`,
      debut: dateIcs(r.date), fin: dateIcs(lendemain(r.date)),
      description: jeRemplace ? 'Vous assurez l\'astreinte ce jour-là.' : 'Vous n\'êtes pas d\'astreinte ce jour-là.'
    });
  }
  for (const l of liens ?? []) {
    const ev = (l as any).evenements;
    if (absent.has(ev.id)) continue;
    const h1 = heureIcs(ev.heure), h2 = heureIcs(ev.heure_fin);
    const d = dateIcs(ev.date);
    if (h1) {
      // Sans heure de fin : durée d'une heure par défaut.
      const fin = h2 && h2 > h1 ? h2 : String(Math.min(parseInt(h1.slice(0, 2), 10) + 1, 23)).padStart(2, '0') + h1.slice(2);
      evts.push({ uid: `evenement-${ev.id}`, titre: ev.intitule, journee: false, debut: `${d}T${h1}`, fin: `${d}T${fin}`, lieu: ev.lieu ?? undefined, description: ev.description ?? undefined });
    } else {
      evts.push({ uid: `evenement-${ev.id}`, titre: ev.intitule, journee: true, debut: d, fin: dateIcs(lendemain(ev.date)), lieu: ev.lieu ?? undefined, description: ev.description ?? undefined });
    }
  }

  const lignes = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Commune de Pasly//Astreintes//FR', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'X-WR-CALNAME:Astreintes Pasly', 'X-WR-TIMEZONE:Europe/Paris',
    'REFRESH-INTERVAL;VALUE=DURATION:PT4H', 'X-PUBLISHED-TTL:PT4H',
    ...VTIMEZONE,
    ...evts.flatMap(vevent),
    'END:VCALENDAR'
  ];
  return new Response(lignes.map(plier).join('\r\n') + '\r\n', {
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': 'inline; filename="astreintes-pasly.ics"',
      'Cache-Control': 'no-cache'
    }
  });
});
