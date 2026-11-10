-- Génération du planning : le compteur d'équité et la règle des semaines
-- consécutives ne tiennent compte que des semaines PUBLIÉES. Auparavant, les
-- propositions non publiées d'une génération précédente étaient comptées
-- alors qu'elles sont recalculées : relancer la génération faussait l'équilibre.

CREATE OR REPLACE FUNCTION public.generer_proposition_planning()
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_semaine record;
  v_choisi uuid;
  v_agent_prec uuid;
  v_agent_suiv uuid;
  v_crees int := 0;
  v_sans_candidat int := 0;
begin
  if not is_admin() then
    raise exception 'Réservé à l''administrateur.';
  end if;

  -- Compteur d'équité : astreintes déjà PUBLIÉES par agent, mis à jour au
  -- fil de la génération pour rester équilibré au sein même de ce lot.
  -- Les propositions non publiées d'une génération précédente ne comptent
  -- pas : elles sont recalculées ici, les compter fausserait l'équilibre.
  create temporary table if not exists tmp_counts (agent_id uuid primary key, n int) on commit drop;
  truncate tmp_counts;
  insert into tmp_counts (agent_id, n)
    select a.id, coalesce(cnt.n, 0)
    from agents a
    left join (
      select p.agent_id, count(*) as n
      from planning p
      join semaines s on s.id = p.semaine_id
      where s.statut = 'publiee'
      group by p.agent_id
    ) cnt on cnt.agent_id = a.id;

  -- Plan de travail : affectations publiées + celles décidées
  -- pendant cette génération (pour la règle anti-consécutif).
  create temporary table if not exists tmp_plan (semaine_id uuid primary key, agent_id uuid) on commit drop;
  truncate tmp_plan;
  insert into tmp_plan
    select p.semaine_id, p.agent_id
    from planning p
    join semaines s on s.id = p.semaine_id
    where s.statut = 'publiee';

  for v_semaine in
    select s.*,
      (select count(*) from disponibilites d
         join agents a on a.id = d.agent_id
         where d.semaine_id = s.id and d.niveau <> 'non'
           and a.actif and a.role <> 'lecteur' and coalesce(a.eligible_astreinte, true)
      ) as nb_candidats
    from semaines s
    where s.statut <> 'publiee'
    order by nb_candidats asc, s.date_debut asc
  loop
    if v_semaine.nb_candidats = 0 then
      v_sans_candidat := v_sans_candidat + 1;
      continue;
    end if;

    select tp.agent_id into v_agent_prec
      from semaines sp join tmp_plan tp on tp.semaine_id = sp.id
      where sp.date_debut = v_semaine.date_debut - 7;

    select tp.agent_id into v_agent_suiv
      from semaines sn join tmp_plan tp on tp.semaine_id = sn.id
      where sn.date_debut = v_semaine.date_debut + 7;

    -- Meilleur candidat en excluant les agents des semaines adjacentes
    select d.agent_id into v_choisi
      from disponibilites d
      join agents a on a.id = d.agent_id
      join tmp_counts tc on tc.agent_id = d.agent_id
      where d.semaine_id = v_semaine.id and d.niveau <> 'non'
        and a.actif and a.role <> 'lecteur' and coalesce(a.eligible_astreinte, true)
        and d.agent_id is distinct from v_agent_prec
        and d.agent_id is distinct from v_agent_suiv
      order by tc.n asc, d.priorite asc
      limit 1;

    -- Repli : si personne d'autre n'est disponible, on accepte un agent adjacent
    if v_choisi is null then
      select d.agent_id into v_choisi
        from disponibilites d
        join agents a on a.id = d.agent_id
        join tmp_counts tc on tc.agent_id = d.agent_id
        where d.semaine_id = v_semaine.id and d.niveau <> 'non'
          and a.actif and a.role <> 'lecteur' and coalesce(a.eligible_astreinte, true)
        order by tc.n asc, d.priorite asc
        limit 1;
    end if;

    insert into planning (semaine_id, agent_id, updated_at)
      values (v_semaine.id, v_choisi, now())
    on conflict (semaine_id) do update set agent_id = excluded.agent_id, updated_at = now();

    insert into tmp_plan (semaine_id, agent_id) values (v_semaine.id, v_choisi)
      on conflict (semaine_id) do update set agent_id = excluded.agent_id;

    update tmp_counts set n = n + 1 where agent_id = v_choisi;

    v_crees := v_crees + 1;
  end loop;

  return json_build_object('ok', true, 'crees', v_crees, 'sans_candidat', v_sans_candidat);
end;
$function$;
