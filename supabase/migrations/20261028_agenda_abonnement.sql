-- Appliquée le 28/10/2026 sur le projet « Astreinte - Pasly ».
create table if not exists public.agenda_jetons (
  agent_id uuid primary key references public.agents(id) on delete cascade,
  jeton text not null unique,
  created_at timestamptz not null default now()
);
alter table public.agenda_jetons enable row level security;
revoke all on public.agenda_jetons from anon, authenticated;

create or replace function public.obtenir_jeton_agenda()
returns text language plpgsql security definer set search_path = public, extensions as $$
declare v_agent uuid := current_agent_id(); v_jeton text;
begin
  if v_agent is null then raise exception 'Agent non identifié ou inactif.'; end if;
  select jeton into v_jeton from agenda_jetons where agent_id = v_agent;
  if v_jeton is null then
    v_jeton := encode(gen_random_bytes(24), 'hex');
    insert into agenda_jetons (agent_id, jeton) values (v_agent, v_jeton);
  end if;
  return v_jeton;
end $$;

create or replace function public.regenerer_jeton_agenda()
returns text language plpgsql security definer set search_path = public, extensions as $$
declare v_agent uuid := current_agent_id(); v_jeton text := encode(gen_random_bytes(24), 'hex');
begin
  if v_agent is null then raise exception 'Agent non identifié ou inactif.'; end if;
  insert into agenda_jetons (agent_id, jeton) values (v_agent, v_jeton)
    on conflict (agent_id) do update set jeton = excluded.jeton, created_at = now();
  return v_jeton;
end $$;

revoke execute on function public.obtenir_jeton_agenda() from public, anon;
revoke execute on function public.regenerer_jeton_agenda() from public, anon;
grant execute on function public.obtenir_jeton_agenda() to authenticated;
grant execute on function public.regenerer_jeton_agenda() to authenticated;
