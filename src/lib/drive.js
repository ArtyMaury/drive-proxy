// src/lib/drive.js
//
// Wrapper minimal autour de l'API Google Drive v3.
// Toutes les fonctions prennent un access_token valide.

const API = "https://www.googleapis.com/drive/v3";
const UPLOAD_API = "https://www.googleapis.com/upload/drive/v3/files";

/** Effectue un appel JSON authentifie vers l'API Drive. */
async function driveFetch(path, accessToken, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(init.headers || {}),
    },
  });
  if (!res.ok) {
    const detail = await res.text();
    const err = new Error(`Drive API ${res.status}: ${detail}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

/**
 * Liste les fichiers et dossiers.
 * @param {string} accessToken
 * @param {object} opts
 * @param {string} [opts.parentId] - id du dossier parent (defaut: tous).
 * @param {string} [opts.pageToken]
 * @param {string} [opts.search] - recherche plein-texte sur le nom.
 */
export async function listFiles(accessToken, { parentId, pageToken, search } = {}) {
  const clauses = ["trashed = false"];
  if (parentId) {
    clauses.push(`'${parentId.replace(/'/g, "\\'")}' in parents`);
  }
  if (search) {
    const safe = search.replace(/'/g, "\\'");
    clauses.push(`name contains '${safe}'`);
  }
  const params = new URLSearchParams({
    q: clauses.join(" and "),
    // Dossiers d'abord, puis par date de modif decroissante.
    orderBy: "folder,modifiedTime desc",
    pageSize: "100",
    fields:
      "nextPageToken, files(id, name, mimeType, size, modifiedTime, iconLink, webViewLink, parents)",
    spaces: "drive",
  });
  if (pageToken) params.set("pageToken", pageToken);
  return driveFetch(`/files?${params.toString()}`, accessToken);
}

/**
 * Liste uniquement les dossiers (pour le selecteur de destination).
 */
export async function listFolders(accessToken, { parentId } = {}) {
  const clauses = [
    "trashed = false",
    "mimeType = 'application/vnd.google-apps.folder'",
  ];
  if (parentId) {
    clauses.push(`'${parentId.replace(/'/g, "\\'")}' in parents`);
  }
  const params = new URLSearchParams({
    q: clauses.join(" and "),
    orderBy: "name",
    pageSize: "200",
    fields: "files(id, name, parents)",
    spaces: "drive",
  });
  return driveFetch(`/files?${params.toString()}`, accessToken);
}

/** Cree un dossier et renvoie ses metadonnees. */
export async function createFolder(accessToken, { name, parentId }) {
  const metadata = {
    name,
    mimeType: "application/vnd.google-apps.folder",
  };
  if (parentId) metadata.parents = [parentId];
  return driveFetch("/files?fields=id,name,parents", accessToken, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(metadata),
  });
}

/**
 * Upload resumable d'un fichier en streaming.
 * Convient aux petits ET gros fichiers, en une seule requete de contenu.
 *
 * @param {string} accessToken
 * @param {object} opts
 * @param {string} opts.name - nom du fichier
 * @param {string} opts.mimeType
 * @param {string} [opts.parentId] - dossier de destination
 * @param {ReadableStream|ArrayBuffer|Blob} opts.body - contenu
 * @param {number} [opts.size] - taille en octets (recommande)
 */
export async function uploadFile(accessToken, { name, mimeType, parentId, body, size }) {
  const metadata = { name };
  if (parentId) metadata.parents = [parentId];

  // 1) Initier la session resumable.
  const initHeaders = {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json; charset=UTF-8",
    "X-Upload-Content-Type": mimeType || "application/octet-stream",
  };
  if (typeof size === "number") {
    initHeaders["X-Upload-Content-Length"] = String(size);
  }

  const initRes = await fetch(
    `${UPLOAD_API}?uploadType=resumable&fields=id,name,mimeType,size,webViewLink,parents`,
    {
      method: "POST",
      headers: initHeaders,
      body: JSON.stringify(metadata),
    },
  );
  if (!initRes.ok) {
    const detail = await initRes.text();
    const err = new Error(`Upload init failed ${initRes.status}: ${detail}`);
    err.status = initRes.status;
    throw err;
  }
  const sessionUri = initRes.headers.get("Location");
  if (!sessionUri) {
    throw new Error("Upload init: missing resumable session URI");
  }

  // 2) Envoyer le contenu en une seule requete PUT.
  const putHeaders = {
    "Content-Type": mimeType || "application/octet-stream",
  };
  if (typeof size === "number") {
    putHeaders["Content-Length"] = String(size);
  }

  const putRes = await fetch(sessionUri, {
    method: "PUT",
    headers: putHeaders,
    body,
  });
  if (!putRes.ok) {
    const detail = await putRes.text();
    const err = new Error(`Upload failed ${putRes.status}: ${detail}`);
    err.status = putRes.status;
    throw err;
  }
  return putRes.json();
}
