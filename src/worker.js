// src/worker.js
//
// Point d'entree du Cloudflare Worker.
// - Sert le frontend statique (binding ASSETS) pour toutes les routes non-/api.
// - Expose une API /api/* qui :
//     * gere le login OAuth Google (avec PKCE),
//     * verifie l'allowlist d'emails,
//     * relaie les appels vers Google Drive (contourne le blocage reseau).
//
// La session (email + tokens Google) est stockee dans un cookie chiffre.

import {
  getSession,
  sessionCookie,
  clearSessionCookie,
  oauthStateCookie,
  getOauthState,
  clearOauthStateCookie,
} from "./lib/session.js";
import {
  SCOPES,
  buildAuthUrl,
  generateState,
  generateCodeVerifier,
  deriveCodeChallenge,
  exchangeCodeForTokens,
  refreshAccessToken,
  decodeIdToken,
} from "./lib/google.js";
import { listFiles, listFolders, createFolder, uploadFile } from "./lib/drive.js";

// ---------------------------------------------------------------------------
// Helpers reponses
// ---------------------------------------------------------------------------

function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers || {}) },
  });
}

function redirect(location, headers = {}) {
  return new Response(null, { status: 302, headers: { Location: location, ...headers } });
}

/** Determine l'URL de base publique (pour construire redirect_uri). */
function baseUrl(request, env) {
  if (env.APP_BASE_URL) return env.APP_BASE_URL.replace(/\/$/, "");
  const url = new URL(request.url);
  return `${url.protocol}//${url.host}`;
}

/** Parse l'allowlist (separateur virgule), normalisee en minuscules. */
function allowedEmails(env) {
  return (env.ALLOWED_EMAILS || "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

function isAllowed(email, env) {
  if (!email) return false;
  return allowedEmails(env).includes(email.toLowerCase());
}

// ---------------------------------------------------------------------------
// Session + tokens : garantit un access_token Google valide
// ---------------------------------------------------------------------------

/**
 * Recupere la session et s'assure que l'access_token n'est pas expire.
 * Rafraichit via refresh_token au besoin.
 *
 * Renvoie { session, setCookie } ou null si non authentifie.
 * `setCookie` est present si la session a ete mise a jour (token rafraichi).
 */
async function requireSession(request, env) {
  const session = await getSession(request, env);
  if (!session || !session.email) return null;
  if (!isAllowed(session.email, env)) return null;

  // Marge de securite de 60s avant expiration.
  const now = Date.now();
  if (session.expiresAt && now < session.expiresAt - 60_000) {
    return { session, setCookie: null };
  }

  // Token expire : on tente un refresh.
  if (!session.refreshToken) return null;
  try {
    const tokens = await refreshAccessToken({
      refreshToken: session.refreshToken,
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
    });
    const updated = {
      ...session,
      accessToken: tokens.access_token,
      expiresAt: Date.now() + (tokens.expires_in || 3600) * 1000,
    };
    const setCookie = await sessionCookie(updated, env);
    return { session: updated, setCookie };
  } catch {
    return null;
  }
}

/** Ajoute l'eventuel Set-Cookie de refresh a une reponse. */
function withCookie(response, setCookie) {
  if (setCookie) response.headers.append("Set-Cookie", setCookie);
  return response;
}

// ---------------------------------------------------------------------------
// Routes OAuth
// ---------------------------------------------------------------------------

async function handleAuthLogin(request, env) {
  try {
    const redirectUri = `${baseUrl(request, env)}/api/auth/callback`;
    const state = generateState();
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = await deriveCodeChallenge(codeVerifier);

    const authUrl = buildAuthUrl({
      clientId: env.GOOGLE_CLIENT_ID,
      redirectUri,
      state,
      codeChallenge,
    });

    // On stocke state + verifier dans un cookie temporaire chiffre.
    const cookie = await oauthStateCookie({ state, codeVerifier }, env);
    return redirect(authUrl, { "Set-Cookie": cookie });
  } catch (e) {
    console.error("[auth/login] echec:", e && e.stack ? e.stack : e);
    return json(
      {
        error: "auth_login_failed",
        name: e?.name || null,
        detail: String(e?.message || e),
      },
      { status: 500 },
    );
  }
}

async function handleAuthCallback(request, env) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  if (error) {
    return redirect(`/?error=${encodeURIComponent(error)}`);
  }
  if (!code || !state) {
    return redirect("/?error=missing_code");
  }

  const saved = await getOauthState(request, env);
  if (!saved || saved.state !== state) {
    return redirect("/?error=bad_state");
  }

  const redirectUri = `${baseUrl(request, env)}/api/auth/callback`;
  let tokens;
  try {
    tokens = await exchangeCodeForTokens({
      code,
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
      redirectUri,
      codeVerifier: saved.codeVerifier,
    });
  } catch {
    return redirect("/?error=token_exchange");
  }

  // Identite de l'utilisateur via l'id_token.
  const claims = tokens.id_token ? decodeIdToken(tokens.id_token) : null;
  const email = claims?.email?.toLowerCase();

  if (!email) {
    return redirect("/?error=no_email");
  }
  if (!isAllowed(email, env)) {
    // Email non autorise : on efface l'etat et on refuse.
    return redirect("/?error=not_allowed", { "Set-Cookie": clearOauthStateCookie() });
  }

  const session = {
    email,
    name: claims?.name || email,
    picture: claims?.picture || null,
    accessToken: tokens.access_token,
    // refresh_token n'est renvoye qu'au premier consentement.
    refreshToken: tokens.refresh_token || null,
    expiresAt: Date.now() + (tokens.expires_in || 3600) * 1000,
  };

  const response = redirect("/");
  response.headers.append("Set-Cookie", await sessionCookie(session, env));
  response.headers.append("Set-Cookie", clearOauthStateCookie());
  return response;
}

function handleAuthLogout() {
  return redirect("/", { "Set-Cookie": clearSessionCookie() });
}

async function handleMe(request, env) {
  const auth = await requireSession(request, env);
  if (!auth) return json({ authenticated: false });
  const { session, setCookie } = auth;
  return withCookie(
    json({
      authenticated: true,
      email: session.email,
      name: session.name,
      picture: session.picture,
    }),
    setCookie,
  );
}

// ---------------------------------------------------------------------------
// Routes Drive (proxy)
// ---------------------------------------------------------------------------

async function handleListFiles(request, env) {
  const auth = await requireSession(request, env);
  if (!auth) return json({ error: "unauthorized" }, { status: 401 });
  const { session, setCookie } = auth;
  const url = new URL(request.url);
  try {
    const data = await listFiles(session.accessToken, {
      parentId: url.searchParams.get("parent") || undefined,
      pageToken: url.searchParams.get("pageToken") || undefined,
      search: url.searchParams.get("q") || undefined,
    });
    return withCookie(json(data), setCookie);
  } catch (e) {
    return withCookie(json({ error: String(e.message || e) }, { status: 502 }), setCookie);
  }
}

async function handleListFolders(request, env) {
  const auth = await requireSession(request, env);
  if (!auth) return json({ error: "unauthorized" }, { status: 401 });
  const { session, setCookie } = auth;
  const url = new URL(request.url);
  try {
    const data = await listFolders(session.accessToken, {
      parentId: url.searchParams.get("parent") || undefined,
    });
    return withCookie(json(data), setCookie);
  } catch (e) {
    return withCookie(json({ error: String(e.message || e) }, { status: 502 }), setCookie);
  }
}

async function handleCreateFolder(request, env) {
  const auth = await requireSession(request, env);
  if (!auth) return json({ error: "unauthorized" }, { status: 401 });
  const { session, setCookie } = auth;
  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: "invalid_json" }, { status: 400 });
  }
  if (!payload?.name) return json({ error: "name_required" }, { status: 400 });
  try {
    const data = await createFolder(session.accessToken, {
      name: payload.name,
      parentId: payload.parentId || undefined,
    });
    return withCookie(json(data), setCookie);
  } catch (e) {
    return withCookie(json({ error: String(e.message || e) }, { status: 502 }), setCookie);
  }
}

async function handleUpload(request, env) {
  const auth = await requireSession(request, env);
  if (!auth) return json({ error: "unauthorized" }, { status: 401 });
  const { session, setCookie } = auth;

  // Le frontend envoie le fichier en multipart/form-data :
  //   - "file"   : le fichier
  //   - "parent" : (optionnel) id du dossier de destination
  let form;
  try {
    form = await request.formData();
  } catch {
    return json({ error: "invalid_form" }, { status: 400 });
  }
  const file = form.get("file");
  if (!file || typeof file === "string") {
    return json({ error: "file_required" }, { status: 400 });
  }
  const parentId = form.get("parent") || undefined;

  try {
    const data = await uploadFile(session.accessToken, {
      name: file.name || "sans-nom",
      mimeType: file.type || "application/octet-stream",
      parentId,
      body: file.stream(),
      size: file.size,
    });
    // Lien vers le dossier de destination dans l'UI Drive.
    // Sans parent explicite, le fichier atterrit a la racine ("Mon Drive").
    const folderId = parentId || (data.parents && data.parents[0]) || null;
    const folderLink = folderId
      ? `https://drive.google.com/drive/folders/${folderId}`
      : "https://drive.google.com/drive/my-drive";
    return withCookie(json({ ...data, folderLink }), setCookie);
  } catch (e) {
    return withCookie(json({ error: String(e.message || e) }, { status: 502 }), setCookie);
  }
}

// ---------------------------------------------------------------------------
// Routeur
// ---------------------------------------------------------------------------

async function handleApi(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  // Auth
  if (path === "/api/auth/login" && method === "GET") return handleAuthLogin(request, env);
  if (path === "/api/auth/callback" && method === "GET") return handleAuthCallback(request, env);
  if (path === "/api/auth/logout") return handleAuthLogout();
  if (path === "/api/me" && method === "GET") return handleMe(request, env);

  // Drive
  if (path === "/api/files" && method === "GET") return handleListFiles(request, env);
  if (path === "/api/folders" && method === "GET") return handleListFolders(request, env);
  if (path === "/api/folders" && method === "POST") return handleCreateFolder(request, env);
  if (path === "/api/upload" && method === "POST") return handleUpload(request, env);

  return json({ error: "not_found" }, { status: 404 });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Verifie la presence des variables/secrets indispensables.
    // On liste precisement ce(ux) qui manque(nt) pour un diagnostic clair.
    if (url.pathname.startsWith("/api/")) {
      const required = [
        "GOOGLE_CLIENT_ID",
        "GOOGLE_CLIENT_SECRET",
        "SESSION_SECRET",
        "ALLOWED_EMAILS",
        "APP_BASE_URL",
      ];
      const missing = required.filter((k) => !env[k]);
      if (missing.length > 0) {
        console.error("[config] Variables manquantes:", missing.join(", "));
        return json(
          {
            error: "server_misconfigured",
            missing,
            detail: `Variables manquantes cote Worker : ${missing.join(", ")}. Definis-les via 'wrangler secret put <NOM>' ou dans le dashboard.`,
          },
          { status: 500 },
        );
      }
    }

    if (url.pathname.startsWith("/api/")) {
      try {
        return await handleApi(request, env);
      } catch (e) {
        // Log complet cote serveur (visible dans `wrangler tail`).
        console.error("[api] Erreur non geree:", e && e.stack ? e.stack : e);
        return json(
          {
            error: "internal",
            name: e?.name || null,
            detail: String(e?.message || e),
            stack: e?.stack ? String(e.stack) : null,
          },
          { status: 500 },
        );
      }
    }

    // Tout le reste : fichiers statiques (frontend).
    return env.ASSETS.fetch(request);
  },
};
