// src/lib/session.js
//
// Gestion des sessions via un cookie signe ET chiffre (AES-GCM).
// On y stocke : l'email de l'utilisateur, son access_token Google,
// le refresh_token, et l'expiration de l'access_token.
//
// La cle de chiffrement derive de SESSION_SECRET (variable secrete).

const COOKIE_NAME = "dp_session";
const OAUTH_STATE_COOKIE = "dp_oauth";
// Duree de vie du cookie de session (7 jours).
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Derive une cle AES-GCM 256 bits a partir du secret texte.
 * @param {string} secret
 * @returns {Promise<CryptoKey>}
 */
async function deriveKey(secret) {
  const hash = await crypto.subtle.digest("SHA-256", encoder.encode(secret));
  return crypto.subtle.importKey("raw", hash, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

/** base64url encode d'un ArrayBuffer/Uint8Array. */
function toBase64Url(bytes) {
  let binary = "";
  const arr = new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) binary += String.fromCharCode(arr[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** base64url decode vers Uint8Array. */
function fromBase64Url(str) {
  const b64 = str.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Chiffre un objet JSON en une chaine transportable dans un cookie.
 * Format: base64url(iv).base64url(ciphertext)
 */
export async function seal(data, secret) {
  const key = await deriveKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = encoder.encode(JSON.stringify(data));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    plaintext,
  );
  return `${toBase64Url(iv)}.${toBase64Url(ciphertext)}`;
}

/**
 * Dechiffre une chaine produite par seal(). Renvoie null si invalide.
 */
export async function unseal(token, secret) {
  try {
    const [ivPart, dataPart] = token.split(".");
    if (!ivPart || !dataPart) return null;
    const key = await deriveKey(secret);
    const iv = fromBase64Url(ivPart);
    const ciphertext = fromBase64Url(dataPart);
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      key,
      ciphertext,
    );
    return JSON.parse(decoder.decode(plaintext));
  } catch {
    return null;
  }
}

/** Parse l'en-tete Cookie en map nom -> valeur. */
function parseCookies(request) {
  const header = request.headers.get("Cookie") || "";
  const out = {};
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const name = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (name) out[name] = decodeURIComponent(value);
  }
  return out;
}

/** Construit la valeur d'un en-tete Set-Cookie. */
function buildCookie(name, value, { maxAge, expires } = {}) {
  let cookie = `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax`;
  if (typeof maxAge === "number") cookie += `; Max-Age=${maxAge}`;
  if (expires) cookie += `; Expires=${expires}`;
  return cookie;
}

/** Lit et dechiffre la session depuis la requete. Renvoie l'objet ou null. */
export async function getSession(request, env) {
  const cookies = parseCookies(request);
  const raw = cookies[COOKIE_NAME];
  if (!raw) return null;
  return unseal(raw, env.SESSION_SECRET);
}

/** Renvoie l'en-tete Set-Cookie qui ecrit la session chiffree. */
export async function sessionCookie(data, env) {
  const sealed = await seal(data, env.SESSION_SECRET);
  return buildCookie(COOKIE_NAME, sealed, { maxAge: SESSION_TTL_SECONDS });
}

/** Renvoie l'en-tete Set-Cookie qui efface la session. */
export function clearSessionCookie() {
  return buildCookie(COOKIE_NAME, "", { maxAge: 0 });
}

/** Cookie temporaire pour stocker le state + code_verifier durant l'OAuth. */
export async function oauthStateCookie(data, env) {
  const sealed = await seal(data, env.SESSION_SECRET);
  // Court : 10 minutes suffisent pour completer le flow.
  return buildCookie(OAUTH_STATE_COOKIE, sealed, { maxAge: 600 });
}

export async function getOauthState(request, env) {
  const cookies = parseCookies(request);
  const raw = cookies[OAUTH_STATE_COOKIE];
  if (!raw) return null;
  return unseal(raw, env.SESSION_SECRET);
}

export function clearOauthStateCookie() {
  return buildCookie(OAUTH_STATE_COOKIE, "", { maxAge: 0 });
}
