-- Demandes devenues sans objet : elles sont désormais closes au moment où
-- elles perdent leur raison d'être, au lieu de rester « en attente ».
--
-- Auparavant, accepter_echange / accepter_remplacement_jour tentaient de les
-- annuler au moment où quelqu'un cliquait sur « Accepter », puis signalaient
-- l'erreur ; or l'erreur annule toute l'opération, y compris cette annulation.
-- La demande restait donc affichée en attente.
--
-- 1. Le titulaire d'une semaine change (échange accepté, modification par
--    l'administrateur) : les demandes d'échange encore en attente pour cette
--    semaine sont refusées, comme l'étaient déjà les remplacements d'un jour.
create or replace function public.cascade_annulation_remplacements()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if TG_OP = 'UPDATE' and OLD.agent_id is distinct from NEW.agent_id then
    update remplacements_jour
      set statut = 'refusee', date_traitement = now()
      where semaine_id = NEW.semaine_id and statut in ('attente', 'acceptee');
    -- L'échange en cours d'acceptation repasse à « acceptée » juste après,
    -- dans accepter_echange ; les autres demandes de la semaine sont closes.
    update echanges
      set statut = 'refusee', date_traitement = now()
      where semaine_id = NEW.semaine_id and statut = 'attente';
  end if;
  return NEW;
end;
$function$;

-- 2. Un remplacement est accepté pour un jour : les autres demandes encore en
--    attente pour ce même jour sont refusées (un seul remplaçant par jour).
--    Ce nettoyage ne doit jamais empêcher l'acceptation elle-même.
create or replace function public.cloturer_remplacements_concurrents()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if new.statut = 'acceptee' and old.statut is distinct from 'acceptee' then
    begin
      update remplacements_jour
        set statut = 'refusee', date_traitement = now()
        where semaine_id = new.semaine_id and date = new.date
          and statut = 'attente' and id <> new.id;
    exception when others then
      raise warning 'Demandes concurrentes non closes : %', sqlerrm;
    end;
  end if;
  return null;
end;
$function$;

revoke execute on function public.cloturer_remplacements_concurrents() from public, anon, authenticated;

drop trigger if exists trg_cloturer_remplacements_concurrents on public.remplacements_jour;
create trigger trg_cloturer_remplacements_concurrents
  after update on public.remplacements_jour
  for each row execute function public.cloturer_remplacements_concurrents();
