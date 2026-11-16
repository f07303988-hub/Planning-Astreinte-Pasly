-- 1. Adresse email d'un agent : toujours enregistrée en minuscules, sans espaces autour.
--    La connexion compare l'adresse de la fiche à celle du compte (toujours en
--    minuscules) : une majuscule saisie par erreur bloquait l'agent.
create or replace function public.normaliser_email_agent()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
begin
  if new.email is not null then
    new.email := lower(btrim(new.email));
  end if;
  return new;
end
$function$;
revoke execute on function public.normaliser_email_agent() from public, anon, authenticated;

drop trigger if exists trg_normaliser_email_agent on public.agents;
create trigger trg_normaliser_email_agent
  before insert or update of email on public.agents
  for each row execute function public.normaliser_email_agent();

-- 2. Purge des notifications lues et anciennes : la fonction s'exécutait avec
--    les droits de la personne connectée, qui n'a pas le droit de supprimer
--    dans la table notifications ; elle ne supprimait donc rien. Elle s'exécute
--    désormais avec ses propres droits, et ne touche qu'aux notifications de
--    la personne connectée.
create or replace function public.nettoyer_mes_notifications()
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_agent uuid := current_agent_id();
begin
  if v_agent is null then return; end if;
  delete from notifications
    where agent_id = v_agent
      and lue = true
      and (
        (type = 'admin_disponibilite' and created_at < now() - interval '7 days')
        or
        (type <> 'admin_disponibilite' and created_at < now() - interval '30 days')
      );
end;
$function$;
revoke execute on function public.nettoyer_mes_notifications() from public, anon;
grant execute on function public.nettoyer_mes_notifications() to authenticated;
