-- Appliquée le 27/10/2026 sur le projet « Astreinte - Pasly ».
alter table public.remplacements_jour
  add column if not exists rappel_envoye boolean not null default false;

-- Événement déplacé : son rappel repart pour la nouvelle date
create or replace function public.reinitialiser_rappel_evenement()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.date is distinct from old.date then
    new.rappel_24h_envoye := false;
  end if;
  return new;
end $$;
create trigger trg_reinitialiser_rappel_evenement
  before update of date on public.evenements
  for each row execute function public.reinitialiser_rappel_evenement();

-- Changement d'agent sur une semaine : le nouvel agent reçoit le rappel des 48 h
create or replace function public.reinitialiser_rappel_astreinte()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.agent_id is distinct from old.agent_id then
    update semaines set rappel_48h_envoye = false where id = new.semaine_id;
  end if;
  return new;
end $$;
revoke execute on function public.reinitialiser_rappel_astreinte() from public, anon, authenticated;
revoke execute on function public.reinitialiser_rappel_evenement() from public, anon, authenticated;
create trigger trg_reinitialiser_rappel_astreinte
  after update of agent_id on public.planning
  for each row execute function public.reinitialiser_rappel_astreinte();
