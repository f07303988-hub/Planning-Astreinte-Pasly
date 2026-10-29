-- Appliquée le 29/10/2026 sur le projet « Astreinte - Pasly ».
-- Mémorise chaque rappel envoyé, destinataire par destinataire.
-- Si Brevo échoue pour une partie des destinataires d'un événement,
-- la nouvelle tentative du lendemain ne renvoie le rappel qu'à ceux
-- qui ne l'ont pas encore reçu (plus de doublon).
--
-- La clé contient la date de l'événement : si l'événement est déplacé,
-- le rappel repart normalement pour la nouvelle date.
create table if not exists public.rappels_envoyes (
  cle text primary key,
  envoye_le timestamptz not null default now()
);

-- Réservée à la fonction serveur (clé service_role) : aucun accès depuis l'appli.
alter table public.rappels_envoyes enable row level security;
revoke all on public.rappels_envoyes from anon, authenticated;
