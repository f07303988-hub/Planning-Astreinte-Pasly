-- Appliquée le 27/10/2026 sur le projet « Astreinte - Pasly ».
-- Prérequis : secret Vault « cle_service_fonctions » (clé service_role), créé à part
-- avec vault.create_secret(...) — jamais versionné ici.

create or replace function public.appeler_notifier_email(p_corps jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare v_cle text;
begin
  select decrypted_secret into v_cle from vault.decrypted_secrets where name = 'cle_service_fonctions';
  if v_cle is null then return; end if;
  perform net.http_post(
    url := 'https://ayfwjgzdspjkmmurefge.supabase.co/functions/v1/notifier-email',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_cle),
    body := p_corps,
    timeout_milliseconds := 30000
  );
exception when others then
  raise warning 'notifier-email non appelé : %', sqlerrm;
end $$;

create or replace function public.trg_email_notification()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform appeler_notifier_email(jsonb_build_object('notification_id', new.id));
  return null;
end $$;

create or replace function public.trg_email_demande_ouverte()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_table_name = 'echanges' then
    perform appeler_notifier_email(jsonb_build_object('echange_ouvert_id', new.id));
  else
    perform appeler_notifier_email(jsonb_build_object('remplacement_ouvert_id', new.id));
  end if;
  return null;
end $$;

revoke execute on function public.appeler_notifier_email(jsonb) from public, anon, authenticated;
revoke execute on function public.trg_email_notification() from public, anon, authenticated;
revoke execute on function public.trg_email_demande_ouverte() from public, anon, authenticated;

create trigger trg_email_notification
  after insert on public.notifications
  for each row
  when (new.type in ('echange_recu','echange_accepte','echange_refuse',
                     'remplacement_recu','remplacement_accepte','remplacement_refuse'))
  execute function public.trg_email_notification();

create trigger trg_email_echange_ouvert
  after insert on public.echanges
  for each row when (new.agent_cible_id is null)
  execute function public.trg_email_demande_ouverte();

create trigger trg_email_remplacement_ouvert
  after insert on public.remplacements_jour
  for each row when (new.agent_remplacant_id is null)
  execute function public.trg_email_demande_ouverte();
