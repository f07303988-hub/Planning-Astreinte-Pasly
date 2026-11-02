-- Sauvegarde automatique : le 1er de chaque mois à 6 h UTC, la fonction
-- « sauvegarde » envoie par email (Excel + copie JSON) toutes les données.
-- La clé de service est lue dans le coffre-fort (Vault), jamais écrite en clair.
select cron.schedule('sauvegarde-mensuelle', '0 6 1 * *', $$
  select net.http_post(
    url := 'https://ayfwjgzdspjkmmurefge.supabase.co/functions/v1/sauvegarde',
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||(select decrypted_secret from vault.decrypted_secrets where name='cle_service_fonctions')),
    body := '{}'::jsonb, timeout_milliseconds := 60000);
$$);
