// Service worker — Pasly RH & Planning
// Permet d'ouvrir l'appli sans réseau et d'y consulter les dernières données
// affichées (planning, astreinte de la semaine, téléphones…).
//
// Stratégie :
//   - page, manifeste, icônes : réseau d'abord, copie locale si hors ligne ;
//   - bibliothèque Supabase (CDN) et polices : copie locale, mise à jour en arrière-plan ;
//   - lectures de données Supabase (GET /rest/v1/) : réseau d'abord, dernière
//     réponse gardée pour le mode hors ligne ;
//   - toute écriture (POST, PATCH, DELETE, fonctions, connexion) : jamais
//     interceptée, elle exige le réseau.
// Les données gardées sont effacées à la déconnexion (message « vider-donnees »).

const VERSION = '2026-10-28b';
const CACHE_APPLI = 'appli-' + VERSION;
const CACHE_DONNEES = 'donnees';
const FICHIERS_APPLI = ['./', 'index.html', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE_APPLI).then(c => c.addAll(FICHIERS_APPLI)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then(noms => Promise.all(noms.filter(n => n.startsWith('appli-') && n !== CACHE_APPLI).map(n => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (e) => {
  if (e.data === 'vider-donnees') e.waitUntil(caches.delete(CACHE_DONNEES));
});

async function reseauDabord(requete, nomCache, cleCache) {
  try {
    const reponse = await fetch(requete);
    if (reponse && (reponse.ok || reponse.type === 'opaque')) {
      const cache = await caches.open(nomCache);
      cache.put(cleCache || requete, reponse.clone());
    }
    return reponse;
  } catch (err) {
    const copie = await caches.match(cleCache || requete, { ignoreVary: true, ignoreSearch: false });
    if (copie) return copie;
    throw err;
  }
}

async function copieLocaleDabord(requete) {
  const cache = await caches.open(CACHE_APPLI);
  const copie = await cache.match(requete, { ignoreVary: true });
  const miseAJour = fetch(requete).then(r => {
    if (r && (r.ok || r.type === 'opaque')) cache.put(requete, r.clone());
    return r;
  }).catch(() => null);
  return copie || (await miseAJour) || Response.error();
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;            // écritures : toujours en direct
  const url = new URL(req.url);

  // Lectures de données Supabase
  if (url.pathname.includes('/rest/v1/')) {
    e.respondWith(reseauDabord(req, CACHE_DONNEES));
    return;
  }
  // Connexion, fonctions, stockage Supabase : jamais mis en cache
  if (url.hostname.endsWith('.supabase.co')) return;

  // Bibliothèques et polices externes
  if (url.hostname === 'cdn.jsdelivr.net' || url.hostname.endsWith('fonts.googleapis.com') || url.hostname.endsWith('fonts.gstatic.com')) {
    e.respondWith(copieLocaleDabord(req));
    return;
  }

  // Fichiers de l'appli (même origine)
  if (url.origin === self.location.origin) {
    // Toute ouverture de page (y compris avec le lien de connexion dans l'adresse)
    // retombe sur index.html si le réseau manque.
    const cle = req.mode === 'navigate' ? new Request(new URL('index.html', self.registration.scope)) : req;
    e.respondWith(reseauDabord(req, CACHE_APPLI, cle));
  }
});
