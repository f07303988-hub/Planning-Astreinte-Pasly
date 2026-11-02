-- Appliquée le 02/11/2026 sur le projet « Astreinte - Pasly ».
-- Demande d'échange ou de remplacement « ouverte à tous » : en plus de
-- l'email, chaque agent éligible (sauf le demandeur) reçoit une notification,
-- donc une alerte sur son téléphone.
create or replace function public.trg_email_demande_ouverte()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_nom text; v_message text; v_type text;
begin
  select nom into v_nom from agents where id = new.agent_demandeur_id;
  if tg_table_name = 'echanges' then
    perform appeler_notifier_email(jsonb_build_object('echange_ouvert_id', new.id));
    v_type := 'echange_ouvert';
    select '🔄 ' || coalesce(v_nom, 'Un agent') || ' cherche quelqu''un pour reprendre sa semaine d''astreinte du '
           || to_char(s.date_debut, 'DD/MM') || ' au ' || to_char(s.date_fin, 'DD/MM') || '.'
      into v_message from semaines s where s.id = new.semaine_id;
  else
    perform appeler_notifier_email(jsonb_build_object('remplacement_ouvert_id', new.id));
    v_type := 'remplacement_ouvert';
    v_message := '🔁 ' || coalesce(v_nom, 'Un agent') || ' cherche un remplaçant pour l''astreinte du '
                 || to_char(new.date, 'DD/MM') || '.';
  end if;

  insert into notifications (agent_id, type, message, contexte)
  select a.id, v_type, v_message, jsonb_build_object('tab', 'echanges', 'semaine_id', new.semaine_id)
  from agents a
  where a.actif and a.id <> new.agent_demandeur_id
    and a.role <> 'lecteur' and a.eligible_astreinte is not false
    and coalesce(a.categorie, 'elu') <> 'communal';
  return null;
end $$;
