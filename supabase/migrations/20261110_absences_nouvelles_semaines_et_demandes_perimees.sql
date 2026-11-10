-- 1. Périodes d'absence appliquées aux semaines créées APRÈS leur saisie.
--    Jusqu'ici, l'appli ne marquait que les semaines déjà ouvertes au moment
--    où l'agent déclarait sa période : sur une semaine créée ensuite, il
--    apparaissait « sans réponse » et recevait les relances. La base applique
--    désormais la période à la création de chaque semaine (la plus récente
--    des périodes qui recoupent la semaine l'emporte, comme dans l'appli).
--    Une réponse déjà enregistrée n'est jamais écrasée.
create or replace function public.appliquer_periodes_nouvelle_semaine()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $fn$
begin
  insert into disponibilites (semaine_id, agent_id, niveau, jours, priorite)
  select new.id, p.agent_id, case when p.disponible_astreinte then 'oui' else 'non' end, '{}'::text[], 2
  from (
    select distinct on (ip.agent_id) ip.agent_id, ip.disponible_astreinte
    from indisponibilites_periodes ip
    join agents a on a.id = ip.agent_id and a.actif
    where ip.date_debut <= new.date_fin and ip.date_fin >= new.date_debut
    order by ip.agent_id, ip.created_at desc
  ) p
  on conflict (semaine_id, agent_id) do nothing;
  return new;
end
$fn$;

revoke execute on function public.appliquer_periodes_nouvelle_semaine() from public, anon, authenticated;

drop trigger if exists trg_appliquer_periodes_nouvelle_semaine on public.semaines;
create trigger trg_appliquer_periodes_nouvelle_semaine
  after insert on public.semaines
  for each row execute function public.appliquer_periodes_nouvelle_semaine();

-- Rattrapage : semaines encore ouvertes aux réponses, déjà créées, qu'une
-- période existante recoupe sans qu'aucune réponse ne soit enregistrée.
insert into disponibilites (semaine_id, agent_id, niveau, jours, priorite)
select s.id, p.agent_id, case when p.disponible_astreinte then 'oui' else 'non' end, '{}'::text[], 2
from semaines s
join lateral (
  select distinct on (ip.agent_id) ip.agent_id, ip.disponible_astreinte
  from indisponibilites_periodes ip
  join agents a on a.id = ip.agent_id and a.actif
  where ip.date_debut <= s.date_fin and ip.date_fin >= s.date_debut
  order by ip.agent_id, ip.created_at desc
) p on true
where s.statut = 'ouverte'
  and s.date_limite_dispo >= (now() at time zone 'Europe/Paris')::date
on conflict (semaine_id, agent_id) do nothing;

-- 2. Échanges et remplacements : plus de demande ni d'acceptation sur une
--    période passée (semaine d'astreinte terminée, jour de remplacement
--    écoulé). Le contrôle porte sur la création d'une demande en attente et
--    sur le passage à « acceptée » ; refuser, annuler ou consulter une
--    ancienne demande reste possible.
create or replace function public.verifier_demande_non_perimee()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare
  v_aujourdhui date := (now() at time zone 'Europe/Paris')::date;
  v_fin date;
begin
  if tg_op = 'INSERT' then
    if new.statut <> 'attente' then return new; end if;
  elsif not (new.statut = 'acceptee' and old.statut is distinct from 'acceptee') then
    return new;
  end if;

  if tg_table_name = 'remplacements_jour' then
    if new.date < v_aujourdhui then
      raise exception 'Ce jour est déjà passé : le remplacement n''est plus possible.';
    end if;
  else
    select date_fin into v_fin from semaines where id = new.semaine_id;
    if v_fin is not null and v_fin < v_aujourdhui then
      raise exception 'Cette semaine d''astreinte est déjà terminée : l''échange n''est plus possible.';
    end if;
  end if;
  return new;
end
$fn$;

revoke execute on function public.verifier_demande_non_perimee() from public, anon, authenticated;

drop trigger if exists trg_verifier_demande_non_perimee on public.echanges;
create trigger trg_verifier_demande_non_perimee
  before insert or update on public.echanges
  for each row execute function public.verifier_demande_non_perimee();

drop trigger if exists trg_verifier_demande_non_perimee on public.remplacements_jour;
create trigger trg_verifier_demande_non_perimee
  before insert or update on public.remplacements_jour
  for each row execute function public.verifier_demande_non_perimee();
