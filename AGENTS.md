# AGENTS.md

Instructions pour les agents IA travaillant sur ce dépôt. À lire avant toute
modification.

## Vue d'ensemble

**Drive Proxy** est une application web qui permet de **consulter et envoyer des
fichiers dans Google Drive**, conçue pour contourner un blocage réseau des API
Google en entreprise.

Le navigateur de l'utilisateur ne parle **jamais** directement à Google : tout
passe par un **Cloudflare Worker** (sur un domaine non bloqué) qui relaie les
appels vers l'API Drive. Chaque utilisateur se connecte avec **son propre compte
Google** et agit sur **son propre Drive**.

```
Navigateur (réseau entreprise)
      |  HTTPS vers le Worker (non bloqué)
      v
Cloudflare Worker  ----- OAuth + API Drive ----->  Google
 (sert le frontend + relaie l'API)
```

## Stack technique

- **Langage** : JavaScript, ES Modules (`"type": "module"`). Pas de build, pas de
  framework, pas de TypeScript.
- **Backend** : Cloudflare Worker (`src/worker.js`), config dans `wrangler.jsonc`.
- **Frontend** : HTML/CSS/JS statique dans `public/`, servi par le Worker via le
  binding `ASSETS`.
- **API externe** : Google Drive API v3 + OAuth 2.0 (avec PKCE).
- **Outillage** : `wrangler` v4 (`npm run dev` / `deploy` / `tail`).

## Structure du projet

```
drive-proxy/
├─ public/              Frontend statique (servi par le Worker)
│  ├─ index.html        Markup : vue login + vue principale + liste fichiers
│  ├─ app.js            Toute la logique front (auth, navigation, liste, upload)
│  └─ styles.css        Styles
├─ src/                 Backend Worker
│  ├─ worker.js         Routeur principal + proxy /api/* + sessions
│  └─ lib/
│     ├─ session.js     Cookies de session chiffrés (AES-GCM)
│     ├─ google.js      OAuth Google (PKCE) + refresh de token + scopes
│     └─ drive.js       Appels API Drive (list, folders, create, upload)
├─ wrangler.jsonc       Config Cloudflare (assets ; secrets hors fichier)
├─ .dev.vars.example    Modèle de secrets locaux
└─ package.json
```

## Architecture du frontend (navigation des fichiers)

L'explorateur de fichiers est un **navigateur en descente progressive
(drill-down), un dossier à la fois** — ce n'est PAS une vue arborescente
imbriquée.

- `state.path` (`public/app.js`) est une pile de navigation `[{ id, name }]`. La
  racine a l'id `null` et s'appelle "Mon Drive".
- Cliquer sur un dossier appelle `openFolder()` : on empile le dossier et on
  recharge la liste avec ses enfants directs.
- `renderBreadcrumb()` affiche le fil d'Ariane cliquable (seul mécanisme de
  hiérarchie : on descend / remonte, on n'imbrique pas).
- `renderFiles()` rend une liste **plate de frères/sœurs** du dossier courant.
  C'est **voulu** : à un niveau donné, les fichiers sont à plat.

### Listing côté Drive (`src/lib/drive.js`, `listFiles`)

- En **recherche** : on parcourt tout le Drive (`name contains '...'`), sans
  filtre de parent.
- **Sans recherche** : on filtre **toujours** sur un parent. Sans `parentId`
  explicite, on scope à la racine du Drive avec **`'root' in parents`**.

  ⚠️ Ne JAMAIS retirer ce filtre de parent : sans lui, la requête Drive devient
  `trashed = false` et Google renvoie **tous les fichiers du Drive à plat**,
  toutes profondeurs confondues. C'était le bug "hiérarchie non respectée".

## Règles importantes

### Ne pas exposer le domaine custom dans le dépôt

Le domaine custom de production (branché côté dashboard Cloudflare) ne doit
**jamais** apparaître dans le code versionné : ni dans `wrangler.jsonc`, ni dans
le frontend, ni dans le README, ni dans aucun fichier committé.

- Le domaine est branché via **Cloudflare dashboard** (Workers & Pages > ce
  worker > Settings > Domains & Routes), pas dans `wrangler.jsonc`.
- Si `wrangler` signale un écart de routes au déploiement, c'est **normal** : ne
  pas ajouter la route locale pour "réparer" l'avertissement.
- L'URL publique réelle vit uniquement dans le secret `APP_BASE_URL` (Cloudflare),
  jamais dans un fichier du dépôt.

### Secrets : jamais versionnés

Aucune valeur sensible dans le dépôt. Tous les secrets sont gérés côté Cloudflare
(`npx wrangler secret put ...`) ou en local dans `.dev.vars` (gitignored) :
`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `SESSION_SECRET`, `ALLOWED_EMAILS`,
`APP_BASE_URL`. Ne jamais committer `.dev.vars`.

### Déploiement : via git, pas `wrangler deploy`

Le dépôt GitHub est **connecté à Cloudflare (Workers Builds)**. Le déploiement se
fait donc en **poussant sur `main`** : Cloudflare build & déploie automatiquement.

- Pour déployer : `git push` sur `main` (après commit). Ne **pas** lancer
  `npm run deploy` / `wrangler deploy` à la main pour les déploiements normaux.
- Toujours inspecter `git status` / `git diff` et ne stager que les fichiers
  voulus. Ne jamais committer de secrets ni de fichiers temporaires.

## Commandes utiles

```bash
npm run dev      # serveur de dev local (http://localhost:8787)
npm run tail     # logs du Worker en production
```

Pas de script de lint / typecheck / test dans ce projet.
