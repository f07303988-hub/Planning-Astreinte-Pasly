-- 1. Planning des agents communaux : un compte NON administrateur ayant le
--    droit « consultation » ou « gestion » ne voyait aucun agent communal (la
--    table agents ne lui montrait que sa propre fiche) : le module restait
--    vide pour lui. Il peut désormais lire les fiches des agents communaux.
drop policy if exists agents_select_communaux on public.agents;
create policy agents_select_communaux on public.agents
  for select to authenticated
  using (categorie = 'communal' and droit_planning_agents_actuel() = any (array['consultation','gestion']));

-- 2. Vue de consultation du planning des agents : ajout des horaires par
--    demi-journée (matin / après-midi), déjà affichés aux gestionnaires.
--    Motif et commentaire restent réservés à la gestion.
create or replace view public.planning_agents_consultation with (security_barrier = true) as
  select id, agent_id, date, type, heure_debut, heure_fin, pause, lieu, remplacant_id, created_at, updated_at,
         matin_debut, matin_fin, apresmidi_debut, apresmidi_fin
  from planning_agents
  where droit_planning_agents_actuel() = any (array['consultation','gestion']);

-- 3. Réponse à un événement (présent / absent) : réservée aux personnes
--    désignées pour cet événement.
alter policy "écriture de sa propre réponse (création)" on public.evenements_reponses
  with check (
    agent_id = current_agent_id()
    and exists (select 1 from evenements_agents ea
                where ea.evenement_id = evenements_reponses.evenement_id and ea.agent_id = current_agent_id())
  );
alter policy "écriture de sa propre réponse (modification)" on public.evenements_reponses
  using (agent_id = current_agent_id())
  with check (
    agent_id = current_agent_id()
    and exists (select 1 from evenements_agents ea
                where ea.evenement_id = evenements_reponses.evenement_id and ea.agent_id = current_agent_id())
  );

-- 4. Test des alertes sur le téléphone : une fois par minute au plus.
create or replace function public.tester_alerte_push()
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_agent uuid := current_agent_id();
begin
  if v_agent is null then raise exception 'Agent non identifié ou inactif.'; end if;
  if exists (select 1 from notifications
             where agent_id = v_agent and type = 'test_push' and created_at > now() - interval '1 minute') then
    raise exception 'Un test vient d''être envoyé : patientez une minute avant de recommencer.';
  end if;
  insert into notifications (agent_id, type, message)
    values (v_agent, 'test_push', '🔔 Test réussi : les alertes fonctionnent sur ce téléphone.');
end $function$;

-- 5. Code d'accès du carnet d'astreinte : la base n'en garde plus que
--    l'empreinte SHA-256 (comme pour le relais de sauvegarde). Le code lui-même
--    n'existe plus que dans le projet « mairie-pasly ». Sans effet si déjà fait.
update public.acces_externes
  set jeton = encode(sha256(convert_to(jeton, 'UTF8')), 'hex')
  where nom = 'carnet_astreinte' and length(jeton) = 48;
