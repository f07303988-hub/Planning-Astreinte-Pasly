-- Quand le titulaire d'une semaine change (échange accepté ou changement décidé
-- par l'administrateur), les remplacements d'un jour déjà acceptés sont
-- annulés. Le remplaçant n'en était pas informé lors d'un échange : il l'est
-- désormais dans tous les cas (notification, alerte téléphone, email), depuis
-- le déclencheur lui-même. reaffecter_astreinte ne fait donc plus que les
-- compter (cette version remplace celle de 20261116_reaffecter_astreinte_publiee).
CREATE OR REPLACE FUNCTION public.cascade_annulation_remplacements()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_aujourdhui date := (now() at time zone 'Europe/Paris')::date;
  v_nouveau_nom text;
begin
  if TG_OP = 'UPDATE' and OLD.agent_id is distinct from NEW.agent_id then
    select nom into v_nouveau_nom from agents where id = NEW.agent_id;
    -- Remplaçants dont un jour accepté (aujourd'hui ou à venir) est annulé.
    -- Un souci de notification ne doit jamais bloquer le changement lui-même.
    begin
      insert into notifications (agent_id, type, message, contexte)
        select r.agent_remplacant_id, 'remplacement_annule',
               '🚫 Votre remplacement d''astreinte du ' || to_char(r.date,'DD/MM') ||
                 ' est annulé : le titulaire de la semaine a changé (' || coalesce(v_nouveau_nom, 'un autre agent') ||
                 ' assure désormais l''astreinte).',
               jsonb_build_object('semaine_id', NEW.semaine_id, 'tab', 'planning')
        from remplacements_jour r
        join agents a on a.id = r.agent_remplacant_id and a.actif
        where r.semaine_id = NEW.semaine_id and r.statut = 'acceptee' and r.date >= v_aujourdhui
          and r.agent_remplacant_id <> NEW.agent_id;
    exception when others then
      raise warning 'Remplaçants non prévenus : %', sqlerrm;
    end;

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

CREATE OR REPLACE FUNCTION public.reaffecter_astreinte(p_semaine_id uuid, p_agent_id uuid)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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

  -- Remplaçants d'un jour déjà acceptés (aujourd'hui ou à venir) : comptés ici,
  -- prévenus par le déclencheur cascade_annulation_remplacements.
  select count(*) into v_nb_remplacants
    from remplacements_jour r
    join agents a on a.id = r.agent_remplacant_id and a.actif
    where r.semaine_id = p_semaine_id and r.statut = 'acceptee' and r.date >= v_aujourdhui
      and r.agent_remplacant_id <> p_agent_id;

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
