// src/lib/google.js
//
// Helpers pour le flow OAuth 2.0 de Google + rafraichissement de token.
// On utilise PKCE (code_verifier / code_challenge) en plus du client_secret.

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

// Scopes demandes :
// - openid/email : pour connaitre l'identite (allowlist).
// - drive.readonly : lecture de TOUT le Drive existant (liste/navigation).
//   Scope "sensible" : peut exiger une verification Google pour la prod
//   (en mode Testing, OK pour ~100 test users).
// - drive.file : ecriture LIMITEE aux fichiers crees/ouverts via cette appli.
//   Necessaire pour l'upload et la creation de dossiers (drive.readonly seul
//   ne permet pas d'ecrire).
export const SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/drive.file",
].join(" ");

const encoder = new TextEncoder();

function toBase64Url(bytes) {
  let binary = "";
  const arr = new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) binary += String.fromCharCode(arr[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Genere un code_verifier PKCE aleatoire (43-128 caracteres). */
export function generateCodeVerifier() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return toBase64Url(bytes);
}

/** Calcule le code_challenge (S256) a partir du verifier. */
export async function deriveCodeChallenge(verifier) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(verifier));
  return toBase64Url(digest);
}

/** Genere une valeur de state anti-CSRF. */
export function generateState() {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(16)));
}

/** Construit l'URL de redirection vers le consentement Google. */
export function buildAuthUrl({ clientId, redirectUri, state, codeChallenge }) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SCOPES,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    // access_type=offline + prompt=consent => on recoit un refresh_token.
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
  });
  return `${AUTH_ENDPOINT}?${params.toString()}`;
}

/** Echange le code d'autorisation contre des tokens. */
export async function exchangeCodeForTokens({
  code,
  clientId,
  clientSecret,
  redirectUri,
  codeVerifier,
}) {
  const body = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
    code_verifier: codeVerifier,
  });
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Token exchange failed (${res.status}): ${detail}`);
  }
  return res.json();
}

/** Rafraichit un access_token expire a partir du refresh_token. */
export async function refreshAccessToken({ refreshToken, clientId, clientSecret }) {
  const body = new URLSearchParams({
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "refresh_token",
  });
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Token refresh failed (${res.status}): ${detail}`);
  }
  return res.json();
}

/**
 * Decode le payload d'un id_token JWT (sans verifier la signature ;
 * le token vient directement de l'endpoint Google via TLS, c'est suffisant ici).
 */
export function decodeIdToken(idToken) {
  const parts = idToken.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const json = atob(payload);
    return JSON.parse(decodeURIComponent(escape(json)));
  } catch {
    return null;
  }
}
