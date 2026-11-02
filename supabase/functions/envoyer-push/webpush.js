// Web Push sans dépendance externe (WebCrypto) — chiffrement « aes128gcm »
// (RFC 8291) et identification du serveur « VAPID » (RFC 8292).
// Fonctionne à l'identique sous Deno (Edge Functions Supabase) et Node.

const enc = new TextEncoder();

export function b64urlEncode(octets) {
  const b = new Uint8Array(octets);
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlDecode(texte) {
  const s = String(texte).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s + '='.repeat((4 - (s.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function concat(...tableaux) {
  const out = new Uint8Array(tableaux.reduce((n, a) => n + a.length, 0));
  let o = 0;
  for (const a of tableaux) { out.set(a, o); o += a.length; }
  return out;
}

async function hmac(cle, donnees) {
  const k = await crypto.subtle.importKey('raw', cle, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, donnees));
}

// Paire de clés VAPID du serveur (générée une seule fois, gardée en base).
export async function genererClesVapid() {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwkPrive = await crypto.subtle.exportKey('jwk', kp.privateKey);
  const brutPublic = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  return {
    jwkPrive: { kty: jwkPrive.kty, crv: jwkPrive.crv, x: jwkPrive.x, y: jwkPrive.y, d: jwkPrive.d },
    clePublique: b64urlEncode(brutPublic)
  };
}

export async function jetonVapid(audience, sujet, jwkPrive) {
  const jwk = { kty: jwkPrive.kty, crv: jwkPrive.crv, x: jwkPrive.x, y: jwkPrive.y, d: jwkPrive.d };
  const cle = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const entete = b64urlEncode(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const corps = b64urlEncode(enc.encode(JSON.stringify({
    aud: audience, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: sujet
  })));
  // WebCrypto renvoie directement la signature au format r||s attendu par JWS.
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, cle, enc.encode(entete + '.' + corps)));
  return entete + '.' + corps + '.' + b64urlEncode(sig);
}

// Chiffre le message pour un téléphone donné (clé p256dh + secret auth).
// (_test : clé éphémère et sel imposés, uniquement pour vérifier le calcul
// avec les valeurs d'exemple de la RFC 8291.)
export async function chiffrer(p256dh, authB64, charge, _test) {
  const uaPublic = b64urlDecode(p256dh);
  const auth = b64urlDecode(authB64);
  const ephemere = _test ? _test.ephemere : await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', ephemere.publicKey));
  const uaCle = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const partage = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaCle }, ephemere.privateKey, 256));

  const prkCle = await hmac(auth, partage);
  const ikm = await hmac(prkCle, concat(enc.encode('WebPush: info\0'), uaPublic, asPublic, new Uint8Array([1])));
  const sel = _test ? _test.sel : crypto.getRandomValues(new Uint8Array(16));
  const prk = await hmac(sel, ikm);
  const cek = (await hmac(prk, concat(enc.encode('Content-Encoding: aes128gcm\0'), new Uint8Array([1])))).slice(0, 16);
  const nonce = (await hmac(prk, concat(enc.encode('Content-Encoding: nonce\0'), new Uint8Array([1])))).slice(0, 12);

  const cleAes = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['encrypt']);
  const chiffre = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, tagLength: 128 }, cleAes, concat(charge, new Uint8Array([2]))
  ));
  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096);
  return concat(sel, rs, new Uint8Array([asPublic.length]), asPublic, chiffre);
}

// Envoie un message (objet JSON) à un abonnement { endpoint, p256dh, auth }.
export async function envoyerPush(abonnement, message, vapid) {
  const corps = await chiffrer(abonnement.p256dh, abonnement.auth, enc.encode(JSON.stringify(message)));
  const jwt = await jetonVapid(new URL(abonnement.endpoint).origin, vapid.sujet, vapid.jwkPrive);
  return fetch(abonnement.endpoint, {
    method: 'POST',
    headers: {
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      'TTL': '86400',
      'Urgency': 'high',
      'Authorization': `vapid t=${jwt}, k=${vapid.clePublique}`
    },
    body: corps
  });
}
