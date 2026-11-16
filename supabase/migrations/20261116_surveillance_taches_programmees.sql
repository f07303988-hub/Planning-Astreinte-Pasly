-- Surveillance des tâches automatiques (rappels quotidiens, sauvegarde mensuelle).
--
-- Jusqu'ici, si l'une d'elles échouait (panne ou quota du service d'emails,
-- clé de service invalide, fonction en erreur), personne n'était prévenu.
-- Chaque lancement est désormais noté dans taches_suivi avec le numéro de
-- l'appel ; vingt minutes plus tard, verifier_taches_programmees relit la
-- réponse du serveur et, si elle n'est pas bonne, prévient les administrateurs
-- (cloche de l'appli + alerte téléphone, qui ne dépendent pas des emails).
create table if not exists public.taches_suivi (
  id bigint generated always as identity primary key,
  tache text not null,
  request_id bigint not null,
  lance_le timestamptz not null default now(),
  verifie_le timestamptz,
  resultat text
);
alter table public.taches_suivi enable row level security;
revoke all on table public.taches_suivi from anon, authenticated;

CREATE OR REPLACE FUNCTION public.verifier_taches_programmees()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_t record;
  v_r record;
  v_resultat text;
  v_jour text;
begin
  for v_t in
    select * from taches_suivi
    where verifie_le is null and lance_le < now() - interval '3 minutes'
    order by lance_le
  loop
    select status_code, timed_out, error_msg into v_r from net._http_response where id = v_t.request_id;
    if not found then
      v_resultat := 'aucune réponse du serveur';
    elsif coalesce(v_r.timed_out, false) then
      v_resultat := 'délai dépassé';
    elsif v_r.status_code between 200 and 299 then
      v_resultat := 'ok';
    else
      v_resultat := coalesce('erreur ' || v_r.status_code, left(v_r.error_msg, 100), 'erreur inconnue');
    end if;

    update taches_suivi set verifie_le = now(), resultat = v_resultat where id = v_t.id;

    if v_resultat <> 'ok' then
      v_jour := to_char(v_t.lance_le at time zone 'Europe/Paris', 'DD/MM');
      perform notifier_admins(
        'admin_alerte',
        case v_t.tache
          when 'rappels-quotidiens' then
            '⚠️ Les rappels automatiques du ' || v_jour || ' ne sont pas tous partis (' || v_resultat ||
            '). Vérifiez vous-même les astreintes et événements des deux prochains jours ; un nouvel essai aura lieu demain matin.'
          when 'sauvegarde-mensuelle' then
            '⚠️ La sauvegarde mensuelle du ' || v_jour || ' n''a pas été envoyée (' || v_resultat ||
            '). Téléchargez-la depuis l''onglet Agents.'
          else
            '⚠️ Tâche automatique « ' || v_t.tache || ' » du ' || v_jour || ' en échec (' || v_resultat || ').'
        end,
        jsonb_build_object('tab', 'admin-planning')
      );
    end if;
  end loop;

  delete from taches_suivi where lance_le < now() - interval '90 days';
end;
$function$;
revoke execute on function public.verifier_taches_programmees() from public, anon, authenticated;

-- Les deux tâches existantes notent désormais leur lancement.
select cron.schedule('rappels-quotidiens', '0 6 * * *', $cron$
  insert into public.taches_suivi (tache, request_id)
  select 'rappels-quotidiens', net.http_post(
    url := 'https://ayfwjgzdspjkmmurefge.supabase.co/functions/v1/rappels-quotidiens',
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||(select decrypted_secret from vault.decrypted_secrets where name='cle_service_fonctions')),
    body := '{}'::jsonb, timeout_milliseconds := 60000);
$cron$);
select cron.schedule('sauvegarde-mensuelle', '0 6 1 * *', $cron$
  insert into public.taches_suivi (tache, request_id)
  select 'sauvegarde-mensuelle', net.http_post(
    url := 'https://ayfwjgzdspjkmmurefge.supabase.co/functions/v1/sauvegarde',
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||(select decrypted_secret from vault.decrypted_secrets where name='cle_service_fonctions')),
    body := '{}'::jsonb, timeout_milliseconds := 60000);
$cron$);
-- Contrôle vingt minutes après.
select cron.schedule('surveillance-taches', '20 6 * * *', $cron$ select public.verifier_taches_programmees(); $cron$);
