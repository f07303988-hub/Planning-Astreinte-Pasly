-- Appliquée le 02/11/2026 sur le projet « Astreinte - Pasly ».
-- Alertes sur le téléphone (Web Push). Les clés VAPID sont créées par la
-- fonction envoyer-push ({ action: 'init' }) et ne sont jamais versionnées.
create table if not exists public.push_config (
  id int primary key check (id = 1),
  cle_publique text not null,
  cle_privee jsonb not null,
  created_at timestamptz not null default now()
);
alter table public.push_config enable row level security;
revoke all on public.push_config from anon, authenticated;

create table if not exists public.push_abonnements (
  endpoint text primary key,
  agent_id uuid not null references public.agents(id) on delete cascade,
  p256dh text not null,
  auth text not null,
  appareil text,
  created_at timestamptz not null default now(),
  dernier_envoi timestamptz
);
create index if not exists push_abonnements_agent_idx on public.push_abonnements(agent_id);
alter table public.push_abonnements enable row level security;
revoke all on public.push_abonnements from anon, authenticated;

create or replace function public.cle_publique_push()
returns text language plpgsql stable security definer set search_path = public as $$
begin
  if current_agent_id() is null then raise exception 'Agent non identifié ou inactif.'; end if;
  return (select cle_publique from push_config where id = 1);
end $$;

create or replace function public.enregistrer_abonnement_push(p_endpoint text, p_p256dh text, p_auth text, p_appareil text default null)
returns void language plpgsql security definer set search_path = public as $$
declare v_agent uuid := current_agent_id();
begin
  if v_agent is null then raise exception 'Agent non identifié ou inactif.'; end if;
  if p_endpoint !~ '^https://(fcm\.googleapis\.com|android\.googleapis\.com|updates\.push\.services\.mozilla\.com|[a-z0-9.-]+\.push\.apple\.com|[a-z0-9.-]+\.notify\.windows\.com)/' then
    raise exception 'Service d''alerte non reconnu.';
  end if;
  if length(p_endpoint) > 1000 or length(p_p256dh) > 200 or length(p_auth) > 100 then
    raise exception 'Abonnement invalide.';
  end if;
  insert into push_abonnements (endpoint, agent_id, p256dh, auth, appareil)
    values (p_endpoint, v_agent, p_p256dh, p_auth, left(p_appareil, 200))
  on conflict (endpoint) do update
    set agent_id = excluded.agent_id, p256dh = excluded.p256dh, auth = excluded.auth,
        appareil = excluded.appareil, created_at = now();
end $$;

create or replace function public.supprimer_abonnement_push(p_endpoint text)
returns void language plpgsql security definer set search_path = public as $$
begin
  delete from push_abonnements where endpoint = p_endpoint and agent_id = current_agent_id();
end $$;

create or replace function public.tester_alerte_push()
returns void language plpgsql security definer set search_path = public as $$
declare v_agent uuid := current_agent_id();
begin
  if v_agent is null then raise exception 'Agent non identifié ou inactif.'; end if;
  insert into notifications (agent_id, type, message)
    values (v_agent, 'test_push', '🔔 Test réussi : les alertes fonctionnent sur ce téléphone.');
end $$;

create or replace function public.agents_alertes_push()
returns table(agent_id uuid, nb_appareils int) language plpgsql stable security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'Réservé aux administrateurs.'; end if;
  return query select a.agent_id, count(*)::int from push_abonnements a group by a.agent_id;
end $$;

revoke execute on function public.cle_publique_push() from public, anon;
revoke execute on function public.enregistrer_abonnement_push(text, text, text, text) from public, anon;
revoke execute on function public.supprimer_abonnement_push(text) from public, anon;
revoke execute on function public.tester_alerte_push() from public, anon;
revoke execute on function public.agents_alertes_push() from public, anon;
grant execute on function public.cle_publique_push() to authenticated;
grant execute on function public.enregistrer_abonnement_push(text, text, text, text) to authenticated;
grant execute on function public.supprimer_abonnement_push(text) to authenticated;
grant execute on function public.tester_alerte_push() to authenticated;
grant execute on function public.agents_alertes_push() to authenticated;

create or replace function public.appeler_envoyer_push(p_corps jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare v_cle text;
begin
  select decrypted_secret into v_cle from vault.decrypted_secrets where name = 'cle_service_fonctions';
  if v_cle is null then return; end if;
  perform net.http_post(
    url := 'https://ayfwjgzdspjkmmurefge.supabase.co/functions/v1/envoyer-push',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_cle),
    body := p_corps,
    timeout_milliseconds := 30000
  );
exception when others then
  raise warning 'envoyer-push non appelé : %', sqlerrm;
end $$;

create or replace function public.trg_push_notification()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from push_abonnements where agent_id = new.agent_id) then
    perform appeler_envoyer_push(jsonb_build_object('notification_id', new.id));
  end if;
  return null;
end $$;

revoke execute on function public.appeler_envoyer_push(jsonb) from public, anon, authenticated;
revoke execute on function public.trg_push_notification() from public, anon, authenticated;

create trigger trg_push_notification
  after insert on public.notifications
  for each row execute function public.trg_push_notification();
