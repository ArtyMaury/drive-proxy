// public/app.js
//
// Logique du frontend : authentification, navigation dans les dossiers,
// liste des fichiers, upload (drag & drop + bouton), creation de dossier.
// Tout passe par l'API du Worker (/api/*), jamais directement par Google.

"use strict";

// ---------------------------------------------------------------------------
// Etat global
// ---------------------------------------------------------------------------

const state = {
  user: null,
  // Pile de navigation : [{ id, name }]. Racine = id null.
  path: [{ id: null, name: "Mon Drive" }],
  files: [],
  searchTimer: null,
};

// Raccourcis DOM
const $ = (sel) => document.querySelector(sel);

const els = {
  loginView: $("#login-view"),
  mainView: $("#main-view"),
  loginError: $("#login-error"),
  userZone: $("#user-zone"),
  destFolder: $("#dest-folder"),
  newFolderBtn: $("#new-folder-btn"),
  dropzone: $("#dropzone"),
  fileInput: $("#file-input"),
  uploadList: $("#upload-list"),
  filesContainer: $("#files-container"),
  breadcrumb: $("#breadcrumb"),
  searchInput: $("#search-input"),
  refreshBtn: $("#refresh-btn"),
  folderDialog: $("#folder-dialog"),
  folderForm: $("#folder-form"),
  folderName: $("#folder-name"),
  toast: $("#toast"),
};

// ---------------------------------------------------------------------------
// Utilitaires
// ---------------------------------------------------------------------------

const FOLDER_MIME = "application/vnd.google-apps.folder";

function currentParentId() {
  return state.path[state.path.length - 1].id;
}

function formatSize(bytes) {
  if (bytes == null) return "";
  const n = Number(bytes);
  if (Number.isNaN(n)) return "";
  if (n < 1024) return `${n} o`;
  const units = ["Ko", "Mo", "Go", "To"];
  let i = -1;
  let val = n;
  do {
    val /= 1024;
    i++;
  } while (val >= 1024 && i < units.length - 1);
  return `${val.toFixed(1)} ${units[i]}`;
}

function formatDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleDateString("fr-FR", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function iconFor(mimeType, name) {
  if (mimeType === FOLDER_MIME) return "\u{1F4C1}"; // dossier
  if (!mimeType) return "\u{1F4C4}";
  if (mimeType.startsWith("image/")) return "\u{1F5BC}\uFE0F";
  if (mimeType.startsWith("video/")) return "\u{1F3AC}";
  if (mimeType.startsWith("audio/")) return "\u{1F3B5}";
  if (mimeType.includes("pdf")) return "\u{1F4D5}";
  if (mimeType.includes("spreadsheet") || /\.(xlsx?|csv)$/i.test(name || ""))
    return "\u{1F4CA}";
  if (mimeType.includes("document") || /\.(docx?|txt|md)$/i.test(name || ""))
    return "\u{1F4DD}";
  if (mimeType.includes("presentation")) return "\u{1F4FD}\uFE0F";
  if (mimeType.includes("zip") || mimeType.includes("compressed"))
    return "\u{1F5DC}\uFE0F";
  return "\u{1F4C4}";
}

function showToast(message, kind = "") {
  els.toast.textContent = message;
  els.toast.className = `toast ${kind}`;
  setTimeout(() => {
    els.toast.classList.add("hidden");
  }, 3500);
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    credentials: "same-origin",
    ...options,
  });
  const contentType = res.headers.get("Content-Type") || "";
  const data = contentType.includes("application/json")
    ? await res.json()
    : null;
  if (!res.ok) {
    const message = data?.error || data?.detail || `Erreur ${res.status}`;
    const err = new Error(message);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

// ---------------------------------------------------------------------------
// Authentification
// ---------------------------------------------------------------------------

const ERROR_MESSAGES = {
  not_allowed:
    "Cet email n'est pas autorise a utiliser cette application.",
  bad_state: "La session de connexion a expire, reessaie.",
  token_exchange: "Echec de l'authentification Google, reessaie.",
  no_email: "Impossible de recuperer ton email Google.",
  missing_code: "Connexion interrompue, reessaie.",
  access_denied: "Tu as refuse l'autorisation.",
};

function showLoginError() {
  const params = new URLSearchParams(location.search);
  const error = params.get("error");
  if (error) {
    els.loginError.textContent =
      ERROR_MESSAGES[error] || `Erreur de connexion (${error}).`;
    els.loginError.classList.remove("hidden");
    // Nettoie l'URL.
    history.replaceState(null, "", location.pathname);
  }
}

async function checkAuth() {
  try {
    const me = await api("/api/me");
    if (me.authenticated) {
      state.user = me;
      renderUser();
      showMainView();
    } else {
      showLoginView();
    }
  } catch {
    showLoginView();
  }
}

function renderUser() {
  if (!state.user) {
    els.userZone.innerHTML = "";
    return;
  }
  const { name, email, picture } = state.user;
  els.userZone.innerHTML = "";

  if (picture) {
    const img = document.createElement("img");
    img.src = picture;
    img.alt = "";
    img.referrerPolicy = "no-referrer";
    els.userZone.appendChild(img);
  }
  const span = document.createElement("span");
  span.className = "muted";
  span.textContent = name || email;
  els.userZone.appendChild(span);

  const logout = document.createElement("a");
  logout.href = "/api/auth/logout";
  logout.className = "btn btn-ghost";
  logout.textContent = "Deconnexion";
  els.userZone.appendChild(logout);
}

function showLoginView() {
  els.loginView.classList.remove("hidden");
  els.mainView.classList.add("hidden");
  showLoginError();
}

function showMainView() {
  els.loginView.classList.add("hidden");
  els.mainView.classList.remove("hidden");
  loadFolderOptions();
  loadFiles();
}

// ---------------------------------------------------------------------------
// Selecteur de dossier de destination
// ---------------------------------------------------------------------------

async function loadFolderOptions(selectedId = "") {
  try {
    const data = await api("/api/folders");
    const folders = data.files || [];
    els.destFolder.innerHTML = "";

    const root = document.createElement("option");
    root.value = "";
    root.textContent = "Racine (Mon Drive)";
    els.destFolder.appendChild(root);

    for (const f of folders) {
      const opt = document.createElement("option");
      opt.value = f.id;
      opt.textContent = f.name;
      els.destFolder.appendChild(opt);
    }
    if (selectedId) els.destFolder.value = selectedId;
  } catch (e) {
    // Non bloquant : on garde au moins la racine.
    console.error("Chargement des dossiers:", e);
  }
}

// ---------------------------------------------------------------------------
// Navigation + liste des fichiers
// ---------------------------------------------------------------------------

function renderBreadcrumb() {
  els.breadcrumb.innerHTML = "";
  state.path.forEach((node, idx) => {
    if (idx > 0) {
      const sep = document.createElement("span");
      sep.className = "sep";
      sep.textContent = "/";
      els.breadcrumb.appendChild(sep);
    }
    if (idx === state.path.length - 1) {
      const cur = document.createElement("span");
      cur.textContent = node.name;
      els.breadcrumb.appendChild(cur);
    } else {
      const link = document.createElement("a");
      link.textContent = node.name;
      link.addEventListener("click", () => {
        state.path = state.path.slice(0, idx + 1);
        loadFiles();
      });
      els.breadcrumb.appendChild(link);
    }
  });
}

function openFolder(folder) {
  state.path.push({ id: folder.id, name: folder.name });
  els.searchInput.value = "";
  loadFiles();
}

async function loadFiles() {
  renderBreadcrumb();
  els.filesContainer.innerHTML = '<p class="muted">Chargement...</p>';

  const search = els.searchInput.value.trim();
  const params = new URLSearchParams();
  // En recherche, on cherche partout ; sinon on filtre sur le dossier courant.
  if (search) {
    params.set("q", search);
  } else {
    const parent = currentParentId();
    if (parent) params.set("parent", parent);
  }

  try {
    const data = await api(`/api/files?${params.toString()}`);
    state.files = data.files || [];
    renderFiles();
  } catch (e) {
    if (e.status === 401) {
      showLoginView();
      return;
    }
    els.filesContainer.innerHTML = `<p class="error">Erreur de chargement : ${escapeHtml(
      e.message,
    )}</p>`;
  }
}

function renderFiles() {
  if (!state.files.length) {
    els.filesContainer.innerHTML =
      '<p class="empty">Aucun fichier ici pour le moment.</p>';
    return;
  }

  const frag = document.createDocumentFragment();
  for (const file of state.files) {
    const isFolder = file.mimeType === FOLDER_MIME;
    const row = document.createElement("div");
    row.className = `file-row${isFolder ? " is-folder" : ""}`;

    const icon = document.createElement("span");
    icon.className = "file-icon";
    icon.textContent = iconFor(file.mimeType, file.name);
    row.appendChild(icon);

    const info = document.createElement("div");
    info.className = "file-info";
    const nameEl = document.createElement("div");
    nameEl.className = "file-name";
    nameEl.textContent = file.name;
    info.appendChild(nameEl);

    const meta = document.createElement("div");
    meta.className = "file-meta";
    const parts = [];
    if (!isFolder && file.size) parts.push(formatSize(file.size));
    if (file.modifiedTime) parts.push(formatDate(file.modifiedTime));
    meta.textContent = parts.join(" \u00B7 ");
    info.appendChild(meta);
    row.appendChild(info);

    if (isFolder) {
      row.addEventListener("click", () => openFolder(file));
    } else if (file.webViewLink) {
      const link = document.createElement("a");
      link.className = "file-link";
      link.href = file.webViewLink;
      link.target = "_blank";
      link.rel = "noopener";
      link.textContent = "Ouvrir \u2197";
      row.appendChild(link);
    }

    frag.appendChild(row);
  }
  els.filesContainer.innerHTML = "";
  els.filesContainer.appendChild(frag);
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

function addUploadItem(name) {
  const li = document.createElement("li");
  li.className = "upload-item";

  const spinner = document.createElement("span");
  spinner.className = "spinner";
  li.appendChild(spinner);

  const nameEl = document.createElement("span");
  nameEl.className = "upload-name";
  nameEl.textContent = name;
  li.appendChild(nameEl);

  const status = document.createElement("span");
  status.className = "upload-status";
  status.textContent = "Envoi...";
  li.appendChild(status);

  els.uploadList.prepend(li);
  return { li, spinner, status };
}

async function uploadOne(file) {
  const ui = addUploadItem(file.name);
  const form = new FormData();
  form.append("file", file);
  const parent = els.destFolder.value;
  if (parent) form.append("parent", parent);

  try {
    await api("/api/upload", { method: "POST", body: form });
    ui.spinner.remove();
    ui.status.textContent = "Envoye \u2713";
    ui.status.classList.add("ok");
    return true;
  } catch (e) {
    ui.spinner.remove();
    ui.status.textContent = `Echec : ${e.message}`;
    ui.status.classList.add("err");
    return false;
  }
}

async function handleFiles(fileList) {
  const files = Array.from(fileList);
  if (!files.length) return;

  let okCount = 0;
  for (const file of files) {
    const ok = await uploadOne(file);
    if (ok) okCount++;
  }

  if (okCount > 0) {
    showToast(
      `${okCount} fichier${okCount > 1 ? "s" : ""} envoye${okCount > 1 ? "s" : ""}.`,
      "ok",
    );
    // Rafraichit la liste si on regarde le dossier de destination.
    const dest = els.destFolder.value || null;
    if (dest === currentParentId() && !els.searchInput.value.trim()) {
      loadFiles();
    }
  }
}

// ---------------------------------------------------------------------------
// Creation de dossier
// ---------------------------------------------------------------------------

async function createFolder(name) {
  const parent = els.destFolder.value || undefined;
  try {
    const folder = await api("/api/folders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, parentId: parent }),
    });
    showToast(`Dossier "${folder.name}" cree.`, "ok");
    // Recharge la liste deroulante et selectionne le nouveau dossier.
    await loadFolderOptions(folder.id);
    // Si on est dans le bon parent, rafraichit la liste.
    if ((parent || null) === currentParentId()) loadFiles();
  } catch (e) {
    showToast(`Erreur : ${e.message}`, "err");
  }
}

// ---------------------------------------------------------------------------
// Evenements
// ---------------------------------------------------------------------------

function wireEvents() {
  // Dropzone : clic -> ouvre le selecteur
  els.dropzone.addEventListener("click", () => els.fileInput.click());
  els.dropzone.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      els.fileInput.click();
    }
  });

  els.fileInput.addEventListener("change", () => {
    handleFiles(els.fileInput.files);
    els.fileInput.value = "";
  });

  // Drag & drop
  ["dragenter", "dragover"].forEach((evt) =>
    els.dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      els.dropzone.classList.add("dragover");
    }),
  );
  ["dragleave", "drop"].forEach((evt) =>
    els.dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      els.dropzone.classList.remove("dragover");
    }),
  );
  els.dropzone.addEventListener("drop", (e) => {
    if (e.dataTransfer?.files?.length) handleFiles(e.dataTransfer.files);
  });

  // Recherche (debounce)
  els.searchInput.addEventListener("input", () => {
    clearTimeout(state.searchTimer);
    state.searchTimer = setTimeout(() => loadFiles(), 350);
  });

  // Rafraichir
  els.refreshBtn.addEventListener("click", () => {
    loadFolderOptions(els.destFolder.value);
    loadFiles();
  });

  // Nouveau dossier
  els.newFolderBtn.addEventListener("click", () => {
    els.folderName.value = "";
    els.folderDialog.showModal();
    els.folderName.focus();
  });

  els.folderForm.addEventListener("submit", (e) => {
    // Le bouton "confirm" valide ; "cancel" ferme juste.
    const action = e.submitter?.value;
    if (action === "confirm") {
      const name = els.folderName.value.trim();
      if (name) createFolder(name);
    }
  });
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

wireEvents();
checkAuth();
