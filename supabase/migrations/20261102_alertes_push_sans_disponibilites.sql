-- Appliquée le 02/11/2026 sur le projet « Astreinte - Pasly ».
-- Les déclarations de disponibilité restent dans la cloche de l'admin,
-- mais ne déclenchent plus d'alerte sur le téléphone (trop fréquentes).
create or replace function public.trg_push_notification()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.type = 'admin_disponibilite' then return null; end if;
  if exists (select 1 from push_abonnements where agent_id = new.agent_id) then
    perform appeler_envoyer_push(jsonb_build_object('notification_id', new.id));
  end if;
  return null;
end $$;
