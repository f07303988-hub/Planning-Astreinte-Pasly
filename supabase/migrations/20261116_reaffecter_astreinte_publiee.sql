-- Changer le titulaire d'une semaine d'astreinte DÉJÀ PUBLIÉE (administrateur).
--
-- Jusqu'ici, une fois la semaine publiée, seul un échange demandé par le
-- titulaire lui-même permettait d'en changer ; l'administrateur n'avait
-- d'autre moyen que de supprimer la semaine (titulaire malade, injoignable…).
--
-- En une seule opération :
--   - le planning passe au nouveau titulaire (les déclencheurs existants
--     vérifient qu'il est éligible, closent les demandes d'échange et de
--     remplacement de la semaine et relancent le rappel 48 h) ;
--   - sont prévenus : le nouveau titulaire, l'ancien, et les remplaçants
--     dont un jour accepté (aujourd'hui ou à venir) est annulé.
-- L'email au nouveau titulaire est envoyé par l'appli (fonction
-- « envoyer-email », action « publication ») ; ceux à l'ancien titulaire et
-- aux remplaçants partent par le déclencheur trg_email_notification.
create or replace function public.reaffecter_astreinte(p_semaine_id uuid, p_agent_id uuid)
returns json
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_moi uuid := current_agent_id();
  v_aujourdhui date := (now() at time zone 'Europe/Paris')::date;
  v_semaine record;
  v_ancien uuid;
  v_ancien_nom text;
  v_ancien_actif boolean;
  v_nouveau record;
  v_periode text;
  v_nb_remplacants int := 0;
begin
  if not is_admin() then
    raise exception 'Réservé à l''administrateur.';
  end if;

  select * into v_semaine from semaines where id = p_semaine_id for update;
  if not found then
    raise exception 'Semaine introuvable.';
  end if;
  if v_semaine.statut <> 'publiee' then
    raise exception 'Cette semaine n''est pas publiée : choisissez l''agent dans la liste puis publiez-la.';
  end if;
  if v_semaine.date_fin < v_aujourdhui then
    raise exception 'Cette semaine d''astreinte est déjà terminée.';
  end if;

  select agent_id into v_ancien from planning where semaine_id = p_semaine_id for update;
  if not found then
    raise exception 'Cette semaine n''a pas de titulaire.';
  end if;
  if v_ancien = p_agent_id then
    raise exception 'Cet agent est déjà le titulaire de cette semaine.';
  end if;

  select * into v_nouveau from agents where id = p_agent_id;
  if not found then
    raise exception 'Agent introuvable.';
  end if;
  select nom, actif into v_ancien_nom, v_ancien_actif from agents where id = v_ancien;

  v_periode := 'semaine du ' || to_char(v_semaine.date_debut,'DD/MM') || ' au ' || to_char(v_semaine.date_fin,'DD/MM');

  -- Remplaçants d'un jour déjà acceptés (aujourd'hui ou à venir) : prévenus
  -- AVANT le changement, qui clôt leurs remplacements.
  insert into notifications (agent_id, type, message, contexte)
    select r.agent_remplacant_id, 'remplacement_annule',
           '🚫 Votre remplacement d''astreinte du ' || to_char(r.date,'DD/MM') ||
             ' est annulé : le titulaire de la semaine a changé (' || v_nouveau.nom || ' assure désormais l''astreinte).',
           jsonb_build_object('semaine_id', p_semaine_id, 'tab', 'planning')
    from remplacements_jour r
    join agents a on a.id = r.agent_remplacant_id and a.actif
    where r.semaine_id = p_semaine_id and r.statut = 'acceptee' and r.date >= v_aujourdhui
      and r.agent_remplacant_id <> p_agent_id
      and r.agent_remplacant_id is distinct from v_moi;
  get diagnostics v_nb_remplacants = row_count;

  update planning set agent_id = p_agent_id, notifie = true, updated_at = now()
    where semaine_id = p_semaine_id;

  if p_agent_id is distinct from v_moi then
    insert into notifications (agent_id, type, message, contexte) values (
      p_agent_id, 'astreinte_publiee',
      '📅 Vous êtes désormais d''astreinte pour la ' || v_periode || ' (changement décidé par l''administrateur).',
      jsonb_build_object('semaine_id', p_semaine_id, 'tab', 'planning')
    );
  end if;

  if coalesce(v_ancien_actif, false) and v_ancien is distinct from v_moi then
    insert into notifications (agent_id, type, message, contexte) values (
      v_ancien, 'astreinte_retiree',
      '↩️ Vous n''êtes plus d''astreinte pour la ' || v_periode || ' : ' || v_nouveau.nom ||
        ' l''assure à votre place (changement décidé par l''administrateur).',
      jsonb_build_object('semaine_id', p_semaine_id, 'tab', 'planning')
    );
  end if;

  return json_build_object(
    'ok', true,
    'ancien_nom', v_ancien_nom,
    'nouveau_nom', v_nouveau.nom,
    'remplacants_prevenus', v_nb_remplacants
  );
end;
$function$;
revoke execute on function public.reaffecter_astreinte(uuid, uuid) from public, anon;
grant execute on function public.reaffecter_astreinte(uuid, uuid) to authenticated;

-- Email aussi pour l'ancien titulaire et les remplaçants annulés.
drop trigger if exists trg_email_notification on public.notifications;
create trigger trg_email_notification
  after insert on public.notifications
  for each row
  when (new.type = any (array['echange_recu','echange_accepte','echange_refuse',
                              'remplacement_recu','remplacement_accepte','remplacement_refuse',
                              'astreinte_retiree','remplacement_annule']))
  execute function public.trg_email_notification();
