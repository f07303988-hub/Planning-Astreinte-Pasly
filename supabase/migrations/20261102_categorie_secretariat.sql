-- Nouvelle catégorie « secretariat » : comptes avec connexion, comme les élus,
-- mais affichés à part dans l'onglet Agents (par défaut exemptés d'astreinte).
alter table public.agents drop constraint agents_categorie_check,
  add constraint agents_categorie_check check (categorie = any (array['elu','secretariat','communal']));
