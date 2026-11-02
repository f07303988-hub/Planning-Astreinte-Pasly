-- Appliquée le 02/11/2026 sur le projet « Astreinte - Pasly ».
-- Notifications (donc alertes téléphone) pour les événements :
-- désignation, déplacement (date/heure), annulation.

create or replace function public.libelle_evenement(e public.evenements)
returns text language sql immutable set search_path = public as $$
  select e.intitule || ', le ' || to_char(e.date, 'DD/MM')
    || coalesce(' à ' || nullif(e.heure, ''), '')
    || coalesce(' (' || nullif(e.lieu, '') || ')', '');
$$;

create or replace function public.trg_notifier_designation_evenement()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_ev evenements; v_moi uuid := current_agent_id();
begin
  select * into v_ev from evenements where id = new.evenement_id;
  if v_ev.id is null or v_ev.date < current_date then return null; end if;
  if new.agent_id = v_moi then return null; end if;
  if not exists (select 1 from agents where id = new.agent_id and actif) then return null; end if;
  if exists (select 1 from notifications where agent_id = new.agent_id and type = 'evenement_designe'
             and contexte->>'evenement_id' = new.evenement_id::text) then return null; end if;
  insert into notifications (agent_id, type, message, contexte) values (
    new.agent_id, 'evenement_designe',
    '📅 Vous êtes désigné(e) : ' || libelle_evenement(v_ev) || '.',
    jsonb_build_object('tab', case when v_ev.publie_reponses then 'dispos' else 'planning' end,
                       'evenement_id', v_ev.id)
  );
  return null;
end $$;

create or replace function public.trg_notifier_changement_evenement()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_moi uuid := current_agent_id();
begin
  if new.date is not distinct from old.date and new.heure is not distinct from old.heure then return null; end if;
  if new.date < current_date then return null; end if;
  insert into notifications (agent_id, type, message, contexte)
  select l.agent_id, 'evenement_modifie',
         '🕒 Changement : ' || libelle_evenement(new) || ' — au lieu du ' || to_char(old.date, 'DD/MM')
           || coalesce(' à ' || nullif(old.heure, ''), '') || '.',
         jsonb_build_object('tab', 'planning', 'evenement_id', new.id)
  from evenements_agents l join agents a on a.id = l.agent_id and a.actif
  where l.evenement_id = new.id and l.agent_id is distinct from v_moi;
  return null;
end $$;

create or replace function public.trg_notifier_annulation_evenement()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_moi uuid := current_agent_id();
begin
  if old.date >= current_date then
    insert into notifications (agent_id, type, message, contexte)
    select l.agent_id, 'evenement_annule', '❌ Annulé : ' || libelle_evenement(old) || '.',
           jsonb_build_object('tab', 'planning')
    from evenements_agents l join agents a on a.id = l.agent_id and a.actif
    where l.evenement_id = old.id and l.agent_id is distinct from v_moi;
  end if;
  return old;
end $$;

revoke execute on function public.trg_notifier_designation_evenement() from public, anon, authenticated;
revoke execute on function public.trg_notifier_changement_evenement() from public, anon, authenticated;
revoke execute on function public.trg_notifier_annulation_evenement() from public, anon, authenticated;

create trigger trg_notifier_designation_evenement
  after insert on public.evenements_agents
  for each row execute function public.trg_notifier_designation_evenement();
create trigger trg_notifier_changement_evenement
  after update of date, heure on public.evenements
  for each row execute function public.trg_notifier_changement_evenement();
create trigger trg_notifier_annulation_evenement
  before delete on public.evenements
  for each row execute function public.trg_notifier_annulation_evenement();
