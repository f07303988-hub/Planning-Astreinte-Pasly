-- Rappels quotidiens : la clé de service n'est plus écrite en clair dans la
-- tâche programmée ; elle est lue dans le coffre-fort (Vault) à chaque exécution.
-- cron.schedule avec le même nom met à jour la tâche existante.
select cron.schedule('rappels-quotidiens', '0 6 * * *', $$
  select net.http_post(
    url := 'https://ayfwjgzdspjkmmurefge.supabase.co/functions/v1/rappels-quotidiens',
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||(select decrypted_secret from vault.decrypted_secrets where name='cle_service_fonctions')),
    body := '{}'::jsonb, timeout_milliseconds := 60000);
$$);
