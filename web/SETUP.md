# Maple's Bean — Setup

## Current mode: **Firebase (raw)**

The storefront now runs on raw Firebase as the primary backend.
PHP/MySQL is included in the project but disabled by default.

---

## Quick start

1. **Create a Firebase project** at https://console.firebase.google.com
2. **Enable Email/Password** sign-in: Build → Authentication → Sign-in method → Email/Password
3. **Enable Google** sign-in (optional): same screen → Google → Enable
4. **Create a Realtime Database**: Build → Realtime Database → Create database (start in test mode for development)
5. **Copy your config** from Project Settings → Your apps → SDK setup → "Config" radio button
6. **Paste it** into `script.js` at the top:

   ```js
   const firebaseConfig = {
     apiKey:            "AIzaSy...",
     authDomain:        "your-project.firebaseapp.com",
     databaseURL:       "https://your-project-default-rtdb.firebaseio.com",
     projectId:         "your-project",
     storageBucket:     "your-project.appspot.com",
     messagingSenderId: "...",
     appId:             "..."
   };
   ```

7. **Run the site**: open `MaplesBean.html` in your browser, or serve the folder over any static host.

> For development you can use `npx serve .` or `python -m http.server 8080`.
> Firebase Auth requires `http://localhost` or `https://` — `file://` won't work.

---

## What runs on Firebase

| Feature | Path |
|---------|------|
| User accounts | `/users/{uid}` |
| Products catalog | `/mb_products/{id}` |
| Orders | `/orders/{id}` |
| Carts | `/carts/{uid}` |
| Reviews | `/reviews/{id}` |
| Inventory | `/inventory/{id}` |
| Wishlists | `/wishlists/{uid}` |
| Live chat | `/chats/{sessionId}` |
| WebRTC signaling | `/webrtc_calls/{callId}` |
| Presence (live visitors) | `/presence/{uid}` |

---

## Firebase security rules (development)

For quick local testing, set permissive rules in the Realtime Database:

```json
{
  "rules": {
    ".read":  "auth != null",
    ".write": "auth != null"
  }
}
```

For production, restrict writes to specific roles (admin / seller) and reads by ownership:

```json
{
  "rules": {
    "users":     { "$uid": { ".read": "auth != null", ".write": "$uid === auth.uid" } },
    "orders":    { "$id":  { ".read": "auth != null", ".write": "auth != null" } },
    "mb_products": { ".read": true, ".write": "auth.token.admin === true" }
  }
}
```

---

## Re-enabling PHP / MySQL (optional)

1. Install XAMPP and import `database/maplesbean.sql` in HeidiSQL.
2. Edit `config/config.php` with your DB credentials.
3. In `api-client.js`, change `usePhpAsPrimary = true`.
4. The auth/login/register form will then route through `/api/auth.php`.

PHP is fully optional — the site is designed to work without it.

---

## Default seed data

The `mb_products` node is auto-populated on first load if empty.
You can manage everything from the in-app Admin Panel after signing in.

---

## Project structure

```
├── MaplesBean.html        ← Storefront UI
├── api-client.js          ← Optional PHP bridge (disabled by default)
├── script.js              ← App logic + Firebase config
├── style.css              ← Warm coffee design system
├── index.php              ← Static redirect to MaplesBean.html
├── config/                ← PHP config (optional)
├── api/                   ← PHP REST endpoints (optional)
├── database/              ← MySQL seed (optional)
└── includes/              ← PHP Firebase backup class (optional)
```

---

## v11 — Separate dashboards, one session, one super admin, CAPTCHA

### Pages
| Role        | Page               |
|-------------|--------------------|
| Super admin | `superadmin.html`  |
| Admin       | `admin.html`       |
| Staff       | `staff.html`       |

After signing in, staff / admin / super admin are sent to their own page. Each page only
accepts its own role. Shared code: `shared.js` (console silencer, Firebase, session lock,
captcha, guard) and `dashboard.js` + `dashboard.css`. Load order on every page: Firebase SDK → `shared.js` → page script.

### One session per account
`sessions/{uid}` holds the active session with a 15 s heartbeat. A second device/browser is refused
while the first is alive; if the first one dies, the lock frees itself after ~45 s. Tabs of the same browser share one session.

### Single super admin
* There is no way in the app (or the PHP backup) to add, demote or delete a super admin.
* Create the one super admin **once** in the Firebase console: `users/{uid}/role = "superadmin"`.
  The first time that account signs in it is pinned in `system/superAdmin` (write-once).
  Any other account stored as `superadmin` is treated as a normal admin.
* Optional: set `SUPER_ADMIN_EMAIL` in `shared.js` so only that email can ever be pinned.
* Admins manage staff / sellers / customers. Only the super admin can create or change admins.

### Security rules
Client code can be bypassed, so publish `database.rules.json` (Realtime Database → Rules).
It enforces the super-admin lock, the role hierarchy and per-user sessions. Test it in the Rules Playground first.

### Console
`shared.js` silences all console output. Add `?debug=1` to a URL to turn it back on while developing.

### PHP backup
Firebase is primary. `PHP_BACKUP` (top of `shared.js`) keeps `api/*.php` as the backup path.
Set it to `false` if you don't host PHP (avoids failed-request lines the browser prints itself).
