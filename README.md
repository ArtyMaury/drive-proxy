# Drive Proxy

Petite application web pour **consulter et envoyer des fichiers dans Google Drive**,
concue pour contourner un blocage reseau des API Google en entreprise.

Le navigateur de l'utilisateur ne parle **jamais** directement a Google : tout
passe par un **Cloudflare Worker** (domaine non bloque), qui relaie les appels
vers l'API Drive. Chaque utilisateur se connecte avec **son propre compte Google**
et pousse les fichiers dans **son propre Drive**.

## Comment ca marche

```
Navigateur (reseau entreprise)
      |
      |  HTTPS vers ton Worker  (non bloque)
      v
Cloudflare Worker  ----- OAuth + API Drive ----->  Google
 (sert le frontend
  + relaie l'API)
```

- **Frontend** : HTML/CSS/JS statique, servi par le Worker (`public/`).
- **Backend** : Worker (`src/`) qui gere le login OAuth (avec PKCE), verifie une
  allowlist d'emails, et proxifie les appels Drive (liste, dossiers, upload).
- **Sessions** : cookie chiffre (AES-GCM) contenant l'email + les tokens Google.

> **Scope Drive utilise** : `drive.file`. L'appli ne voit que les fichiers
> qu'elle a elle-meme crees/ouverts (le plus sur, validation Google rapide).
> Pour voir **tout** le Drive existant de l'utilisateur, voir
> [Variante : acces complet au Drive](#variante--acces-complet-au-drive).

---

## Prerequis

- Un compte [Cloudflare](https://dash.cloudflare.com/sign-up) (gratuit).
- _(Optionnel)_ Un domaine gere dans Cloudflare (zone DNS Cloudflare) si tu veux
  un domaine custom. Sinon tu utilises l'URL gratuite `*.workers.dev`.
- Node.js 18+ installe localement.
- Un projet [Google Cloud Console](https://console.cloud.google.com/).

---

## 1. Configurer OAuth dans Google Cloud

1. Va sur https://console.cloud.google.com/ et cree (ou selectionne) un projet.
2. **Active l'API Drive** :
   _APIs & Services > Library_ > cherche **Google Drive API** > **Enable**.
3. **Ecran de consentement OAuth** :
   _APIs & Services > OAuth consent screen_.
   - User type : **External**.
   - Renseigne le nom de l'app, ton email de support, etc.
   - **Scopes** : ajoute `.../auth/drive.file` (et `openid`, `email`).
   - **Test users** : ajoute les emails autorises tant que l'app est en mode
     "Testing".
4. **Credentials** :
   _APIs & Services > Credentials_ > **Create Credentials** > **OAuth client ID**.
   - Application type : **Web application**.
   - **Authorized redirect URIs** : ajoute l'URL de callback de ton deploiement,
     au format `https://<ton-domaine>/api/auth/callback`. Exemples :
     ```
     https://votre-app.votre-sous-domaine.workers.dev/api/auth/callback
     ```
     Pour le dev local, ajoute aussi :
     ```
     http://localhost:8787/api/auth/callback
     ```
   - Cree, puis note le **Client ID** et le **Client secret**.

---

## 2. Installer le projet

```bash
npm install
```

---

## 3. Tester en local

1. Cree le fichier de secrets local a partir de l'exemple :

   ```bash
   cp .dev.vars.example .dev.vars
   ```

2. Edite `.dev.vars` et remplis :
   - `GOOGLE_CLIENT_ID`
   - `GOOGLE_CLIENT_SECRET`
   - `SESSION_SECRET` (genere une cle : `openssl rand -base64 48`)
   - `ALLOWED_EMAILS` (ton email, separes par des virgules si plusieurs)
   - `APP_BASE_URL="http://localhost:8787"` pour le local.

3. Lance le serveur de dev :

   ```bash
   npm run dev
   ```

   Ouvre http://localhost:8787 et connecte-toi avec un email present dans
   `ALLOWED_EMAILS`.

---

## 4. Deployer en production

### a) Definir les secrets sur Cloudflare

Aucune valeur sensible n'est versionnee. On pousse tout via la CLI
(chaque commande demande la valeur de maniere interactive) :

```bash
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put SESSION_SECRET
npx wrangler secret put ALLOWED_EMAILS   # ex: toi@example.com,collegue@example.com
npx wrangler secret put APP_BASE_URL     # l'URL publique de ton Worker
```

> `APP_BASE_URL` doit correspondre a l'URL publique reelle (workers.dev ou ton
> domaine custom) et etre la meme que la redirect URI declaree dans Google.

### b) Deployer

```bash
npm run deploy
```

Tu obtiens une URL `https://<nom>.<ton-sous-domaine>.workers.dev`.
Mets cette URL dans `APP_BASE_URL` (secret) **et** dans les redirect URIs Google.

### c) (Optionnel) Brancher un domaine custom

Le domaine n'est volontairement **pas** dans la config versionnee. Pour en
ajouter un, fais-le depuis le dashboard Cloudflare :

_Workers & Pages > (ce worker) > Settings > Domains & Routes > Add > Custom domain_

Le domaine doit appartenir a une zone geree par Cloudflare. Cloudflare cree
l'enregistrement DNS et le certificat TLS automatiquement. Pense ensuite a
mettre a jour `APP_BASE_URL` et la redirect URI Google avec ce domaine.

---

## Ajouter / retirer des utilisateurs

Mets a jour le secret `ALLOWED_EMAILS` (liste separee par des virgules) :

```bash
npx wrangler secret put ALLOWED_EMAILS
```

N'oublie pas d'ajouter aussi les nouveaux emails comme **Test users** dans
l'ecran de consentement Google (tant que l'app est en mode Testing).

---

## Variante : acces complet au Drive

Par defaut le scope est `drive.file` (uniquement les fichiers de l'appli).
Pour lister/gerer **tout** le Drive existant de l'utilisateur :

1. Dans `src/lib/google.js`, remplace dans `SCOPES` :
   ```
   https://www.googleapis.com/auth/drive.file
   ```
   par
   ```
   https://www.googleapis.com/auth/drive
   ```
2. Ajoute ce scope dans l'ecran de consentement Google.
3. Attention : ce scope "sensible" peut exiger une **verification Google** de
   l'app pour sortir du mode Testing (sinon limite a ~100 test users).

---

## Structure du projet

```
drive-proxy/
├─ public/              Frontend statique (servi par le Worker)
│  ├─ index.html
│  ├─ styles.css
│  └─ app.js
├─ src/                 Backend Worker
│  ├─ worker.js         Routeur principal + proxy
│  └─ lib/
│     ├─ session.js     Cookies chiffres (AES-GCM)
│     ├─ google.js      OAuth Google (PKCE) + refresh
│     └─ drive.js       Appels API Drive (list, folders, upload)
├─ wrangler.jsonc       Config Cloudflare (assets ; secrets hors fichier)
├─ .dev.vars.example    Modele de secrets locaux
└─ package.json
```

## Securite : points cles

- `client_secret` et `SESSION_SECRET` restent **cote serveur** (secrets Cloudflare).
- Les cookies de session sont **chiffres + signes**, `HttpOnly`, `Secure`, `SameSite=Lax`.
- OAuth protege par **state** (anti-CSRF) et **PKCE**.
- Acces filtre par **allowlist d'emails** verifiee a chaque requete.

## Limites du plan gratuit

- Cloudflare Workers : 100 000 requetes/jour (largement suffisant ici).
- Upload : la taille max d'une requete sur le plan gratuit est de **100 Mo**.
  Pour de plus gros fichiers, il faudrait un upload resumable par chunks
  cote client (non implemente).
