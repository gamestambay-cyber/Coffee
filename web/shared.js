/* ═══════════════════════════════════════════════════════
   MAPLE'S BEAN — Shared core (loaded FIRST on every page)

   1. Silences the browser console (no logs, warnings or errors)
   2. Firebase init (one place, used by storefront + dashboards)
   3. One-session-per-account lock
   4. Single Super Admin rules
   5. Basic CAPTCHA widget
   6. Role → dashboard routing + page guard for dashboards
═══════════════════════════════════════════════════════ */
(function (global) {
  "use strict";

  /* ───────────────────────────────────────────────
     1. CONSOLE SILENCER
     Add ?debug=1 to the URL (or localStorage mb_debug=1)
     if you ever need the console back while developing.
  ─────────────────────────────────────────────── */
  var DEBUG = false;
  try {
    DEBUG = /[?&]debug=1(&|$)/.test(global.location.search) ||
            global.localStorage.getItem("mb_debug") === "1";
  } catch (e) {}

  if (!DEBUG) {
    var noop = function () {};
    ["log", "info", "warn", "error", "debug", "trace", "dir", "dirxml", "table",
     "group", "groupCollapsed", "groupEnd", "time", "timeEnd", "timeLog", "count",
     "countReset", "assert", "profile", "profileEnd", "timeStamp"
    ].forEach(function (m) { try { global.console[m] = noop; } catch (e) {} });
    try { global.console.clear(); } catch (e) {}
    // Uncaught errors / rejected promises would otherwise print to the console.
    global.addEventListener("error", function (e) { try { e.preventDefault(); } catch (x) {} });
    global.addEventListener("unhandledrejection", function (e) { try { e.preventDefault(); } catch (x) {} });
  }

  /* ───────────────────────────────────────────────
     2. FIREBASE
  ─────────────────────────────────────────────── */
  var firebaseConfig = {
  apiKey: "AIzaSyC9er7KoS8irssT2wk8WDYAO_bhL5uiLa4",
  authDomain: "hightype-3e77a.firebaseapp.com",
  databaseURL: "https://hightype-3e77a-default-rtdb.firebaseio.com",
  projectId: "hightype-3e77a",
  storageBucket: "hightype-3e77a.firebasestorage.app",
  messagingSenderId: "795012496754",
  appId: "1:795012496754:web:e0d3671e36ceec54c071eb",
  measurementId: "G-MB6DKVN19X"
  };

  /* Firebase is the primary backend. PHP/MySQL (api/*.php) is the BACKUP:
     used when a Firebase call fails, and kept in sync after Firebase writes.
     Set to false if you do not host the PHP folder. */
  var PHP_BACKUP = false; // Firebase Realtime Database only; no PHP/MySQL fallback.

  var db = null, auth = null, googleProvider = null, ready = false;
  try {
    if (typeof global.firebase !== "undefined") {
      if (!global.firebase.apps.length) global.firebase.initializeApp(firebaseConfig);
      db = global.firebase.database();
      auth = global.firebase.auth();
      googleProvider = new global.firebase.auth.GoogleAuthProvider();
      try { global.firebase.database.enableLogging(false); } catch (e) {}
      ready = true;
    }
  } catch (e) { ready = false; }

  /* ───────────────────────────────────────────────
     ROLES
  ─────────────────────────────────────────────── */
  function normalizeRole(role) {
    var r = String(role || "customer").trim().toLowerCase().replace(/[ -]/g, "_");
    if (r === "super_admin" || r === "superadmin") return "superadmin";
    if (["admin", "staff", "seller", "customer"].indexOf(r) !== -1) return r;
    return "customer";
  }

  var DASHBOARD_PAGE = {
    superadmin: "superadmin.html",
    admin: "admin.html",
    staff: "staff.html"
  };
  function dashboardFor(role) { return DASHBOARD_PAGE[role] || null; }

  /* ───────────────────────────────────────────────
     4. SINGLE SUPER ADMIN
     There is exactly ONE super admin. Nobody can create another one
     and nobody can remove this one from the app.

     The super admin is whoever is pinned in  system/superAdmin  (a
     write-once record). On the very first login of an account whose
     role is already "superadmin" in the database, that account is
     pinned automatically. Any other account that has "superadmin"
     stored is treated as a normal admin.

     OPTIONAL: put the super admin's email here so that ONLY that
     account can ever be pinned.
  ─────────────────────────────────────────────── */
  var SUPER_ADMIN_EMAIL = "";

  function getSuperAdminPointer() {
    return db.ref("system/superAdmin").once("value").then(function (s) { return s.val(); });
  }

  function resolveRole(user, profile) {
    var stored = normalizeRole(profile && profile.role);
    if (stored !== "superadmin") return Promise.resolve(stored);
    var email = String((user && user.email) || "").toLowerCase();
    return getSuperAdminPointer().then(function (ptr) {
      var canClaim = !ptr && (!SUPER_ADMIN_EMAIL || email === SUPER_ADMIN_EMAIL.toLowerCase());
      if (!canClaim) return ptr;
      return db.ref("system/superAdmin").transaction(function (cur) {
        if (cur) return undefined;               // already pinned → abort
        return { uid: user.uid, email: email, at: Date.now() };
      }).then(function () { return getSuperAdminPointer(); });
    }).then(function (ptr) {
      return ptr && ptr.uid === user.uid ? "superadmin" : "admin";
    }).catch(function () { return "admin"; });
  }

  /* ───────────────────────────────────────────────
     3. ONE SESSION PER ACCOUNT
     sessions/{uid} = { sid, at }   (heartbeat every 15 s)
     A second login is REFUSED while the first one is alive.
     If the first one dies (closed tab, no network) the lock
     frees itself after SESSION_TTL.
     Tabs of the same browser share one session id.
  ─────────────────────────────────────────────── */
  var SESSION_TTL = 45000;
  var HEARTBEAT_MS = 15000;
  var SID = (function () {
    try {
      var s = global.localStorage.getItem("mb_sid");
      if (!s) {
        s = Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 12);
        global.localStorage.setItem("mb_sid", s);
      }
      return s;
    } catch (e) { return "s-" + Math.random().toString(36).slice(2, 14); }
  })();

  var activeUid = null, hbTimer = null, sessRef = null, claiming = null;
  var kickHandler = function () {};
  function setKickHandler(fn) { kickHandler = fn || function () {}; }

  function stopSession() {
    if (hbTimer) { clearInterval(hbTimer); hbTimer = null; }
    if (sessRef) {
      try { sessRef.off(); } catch (e) {}
      try { sessRef.onDisconnect().cancel(); } catch (e) {}
    }
    sessRef = null; activeUid = null; claiming = null;
  }

  function claimSession(user) {
    if (!ready || !user) return Promise.resolve(true);
    if (activeUid === user.uid) return Promise.resolve(true);
    if (claiming && claiming.uid === user.uid) return claiming.promise;

    var ref = db.ref("sessions/" + user.uid);
    var p = ref.transaction(function (cur) {
      var now = Date.now();
      if (cur && cur.sid !== SID && (now - (cur.at || 0)) < SESSION_TTL) return undefined; // taken → abort
      return { sid: SID, at: now };
    }, undefined, false).then(function (res) {
      if (!res.committed) { claiming = null; return false; }
      activeUid = user.uid; sessRef = ref; claiming = null;
      try { ref.onDisconnect().remove(); } catch (e) {}

      // Heartbeat keeps the lock alive and re-creates it after a network blip.
      hbTimer = setInterval(function () {
        ref.transaction(function (cur) {
          if (cur && cur.sid !== SID) return undefined;
          return { sid: SID, at: Date.now() };
        }, undefined, false).catch(function () {});
        try { ref.onDisconnect().remove(); } catch (e) {}
      }, HEARTBEAT_MS);

      // Someone else owns the session now (we were stale) → leave.
      ref.on("value", function (snap) {
        var v = snap.val();
        if (v && v.sid !== SID && activeUid === user.uid) {
          stopSession();
          kickHandler("kicked");
        }
      });
      return true;
    }).catch(function () {
      claiming = null;
      return true; // rules/network problem: do not lock real users out
    });

    claiming = { uid: user.uid, promise: p };
    return p;
  }

  function releaseSession() {
    if (!ready || !activeUid || !sessRef) { stopSession(); return Promise.resolve(); }
    var ref = sessRef;
    stopSession();
    return ref.transaction(function (cur) {
      return (cur && cur.sid === SID) ? null : cur; // only delete OUR lock
    }, undefined, false).catch(function () {});
  }

  function signOutEverywhere() {
    return releaseSession().then(function () { return ready ? auth.signOut() : null; });
  }

  var SESSION_BLOCKED_MSG =
    "This account is already signed in on another device or browser. " +
    "Sign out there first, or wait a minute if that session was closed.";

  /* ───────────────────────────────────────────────
     5. BASIC CAPTCHA (canvas text, client-side)
  ─────────────────────────────────────────────── */
  var CAPTCHA_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I
  function rnd(n) {
    if (global.crypto && global.crypto.getRandomValues) {
      var a = new Uint32Array(1); global.crypto.getRandomValues(a);
      return a[0] % n;
    }
    return Math.floor(Math.random() * n);
  }

  function createCaptcha(host) {
    if (!host) return { check: function () { return true; }, refresh: function () {}, reset: function () {} };
    var W = 168, H = 52, answer = "";
    host.classList.add("captcha");
    host.innerHTML = "";

    var canvas = document.createElement("canvas");
    canvas.width = W; canvas.height = H;
    canvas.className = "captcha-canvas";
    canvas.setAttribute("aria-label", "CAPTCHA image");

    var refreshBtn = document.createElement("button");
    refreshBtn.type = "button";
    refreshBtn.className = "captcha-refresh";
    refreshBtn.title = "New code";
    refreshBtn.setAttribute("aria-label", "Get a new code");
    refreshBtn.textContent = "↻";

    var input = document.createElement("input");
    input.type = "text";
    input.className = "captcha-input";
    input.placeholder = "Type the code shown";
    input.autocomplete = "off";
    input.autocapitalize = "characters";
    input.spellcheck = false;
    input.maxLength = 5;
    input.setAttribute("aria-label", "CAPTCHA code");

    var row = document.createElement("div");
    row.className = "captcha-row";
    row.appendChild(canvas); row.appendChild(refreshBtn);
    host.appendChild(row); host.appendChild(input);

    var fallback = null;
    function draw() {
      answer = "";
      for (var i = 0; i < 5; i++) answer += CAPTCHA_CHARS.charAt(rnd(CAPTCHA_CHARS.length));
      var ctx = null;
      try { ctx = canvas.getContext("2d"); } catch (e) { ctx = null; }
      if (!ctx) {                                   // no canvas support: show the code as plain text
        if (!fallback) {
          fallback = document.createElement("div");
          fallback.className = "captcha-canvas";
          fallback.style.cssText = "display:flex;align-items:center;justify-content:center;font:bold 24px monospace;letter-spacing:.3em";
          row.replaceChild(fallback, canvas);
        }
        fallback.textContent = answer;
        return;
      }

      var g = ctx.createLinearGradient(0, 0, W, H);
      g.addColorStop(0, "#efe4cf"); g.addColorStop(1, "#ddc99e");
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);

      for (var l = 0; l < 7; l++) {                       // noise lines
        ctx.strokeStyle = "rgba(34,21,16," + (0.18 + rnd(30) / 100) + ")";
        ctx.lineWidth = 1 + rnd(2);
        ctx.beginPath();
        ctx.moveTo(rnd(W), rnd(H));
        ctx.bezierCurveTo(rnd(W), rnd(H), rnd(W), rnd(H), rnd(W), rnd(H));
        ctx.stroke();
      }
      for (var d = 0; d < 60; d++) {                      // noise dots
        ctx.fillStyle = "rgba(109,35,49," + (0.15 + rnd(40) / 100) + ")";
        ctx.fillRect(rnd(W), rnd(H), 2, 2);
      }

      var fonts = ["Georgia", "Courier New", "Trebuchet MS", "Verdana"];
      for (var c = 0; c < answer.length; c++) {
        ctx.save();
        ctx.font = "bold " + (26 + rnd(7)) + "px " + fonts[rnd(fonts.length)] + ", serif";
        ctx.fillStyle = "rgb(" + (20 + rnd(70)) + "," + (10 + rnd(40)) + "," + (10 + rnd(50)) + ")";
        ctx.textBaseline = "middle";
        ctx.translate(16 + c * 30, H / 2 + (rnd(11) - 5));
        ctx.rotate((rnd(60) - 30) / 100);
        ctx.fillText(answer.charAt(c), 0, 0);
        ctx.restore();
      }

      ctx.strokeStyle = "rgba(34,21,16,.55)"; ctx.lineWidth = 1.6; // strike-through wave
      ctx.beginPath();
      var y0 = H / 2 + rnd(10) - 5;
      ctx.moveTo(0, y0);
      for (var x = 0; x <= W; x += 6) ctx.lineTo(x, y0 + Math.sin(x / 9 + rnd(6)) * 6);
      ctx.stroke();
    }

    function reset() { input.value = ""; draw(); }
    refreshBtn.addEventListener("click", function () { reset(); input.focus(); });

    draw();

    return {
      refresh: reset,
      reset: reset,
      // Returns true when the typed code matches. A new code is ALWAYS generated
      // afterwards, so one answer can never be reused.
      check: function () {
        var ok = answer.length === 5 && input.value.trim().toUpperCase() === answer;
        reset();
        if (!ok) input.focus();
        return ok;
      },
      isFilled: function () { return input.value.trim().length > 0; }
    };
  }

  /* ───────────────────────────────────────────────
     6. DASHBOARD PAGE GUARD
  ─────────────────────────────────────────────── */
  function showDenied(message, linkHref, linkText) {
    var wrap = document.getElementById("dashDenied");
    var app = document.getElementById("dashApp");
    var boot = document.getElementById("dashBoot");
    if (app) app.hidden = true;
    if (boot) boot.hidden = true;
    if (wrap) {
      wrap.hidden = false;
      var m = wrap.querySelector("[data-denied-msg]");
      if (m) m.textContent = message;
      var a = wrap.querySelector("[data-denied-link]");
      if (a) { a.href = linkHref || "index.html"; a.textContent = linkText || "Back to the shop"; }
    }
  }

  /**
   * guardPage({ allow:['admin'], page:'admin.html' })
   * Resolves { user, profile, role } once the visitor is signed in,
   * holds the only session for the account and has an allowed role.
   */
  function guardPage(opts) {
    return new Promise(function (resolve) {
      if (!ready) { showDenied("The database could not be reached. Check your connection and try again."); return; }

      setKickHandler(function () {
        auth.signOut().then(function () {
          global.location.replace("index.html?kicked=1");
        });
      });

      var first = true;
      auth.onAuthStateChanged(function (u) {
        if (!first) {                                  // signed out in another tab
          if (!u) global.location.replace("index.html");
          return;
        }
        first = false;

        if (!u) {
          global.location.replace("index.html?login=1&next=" + encodeURIComponent(opts.page || ""));
          return;
        }
        claimSession(u).then(function (ok) {
          if (!ok) {
            auth.signOut();
            showDenied(SESSION_BLOCKED_MSG, "index.html", "Back to the shop");
            return;
          }
          return db.ref("users/" + u.uid).once("value").then(function (snap) {
            var profile = snap.val() || {};
            return resolveRole(u, profile).then(function (role) {
              if (opts.allow.indexOf(role) === -1) {
                var own = dashboardFor(role);
                showDenied("Your account (" + role + ") does not have access to this page.",
                           own || "index.html", own ? "Go to my dashboard" : "Back to the shop");
                return;
              }
              resolve({ user: u, profile: profile, role: role });
            });
          });
        }).catch(function () {
          showDenied("We could not verify your account. Please sign in again.", "index.html", "Back to the shop");
        });
      });
    });
  }

  global.MBCore = {
    DEBUG: DEBUG,
    ready: ready, db: db, auth: auth, googleProvider: googleProvider,
    firebaseConfig: firebaseConfig,
    PHP_BACKUP: PHP_BACKUP,
    normalizeRole: normalizeRole,
    dashboardFor: dashboardFor,
    resolveRole: resolveRole,
    claimSession: claimSession,
    releaseSession: releaseSession,
    signOutEverywhere: signOutEverywhere,
    setKickHandler: setKickHandler,
    SESSION_BLOCKED_MSG: SESSION_BLOCKED_MSG,
    createCaptcha: createCaptcha,
    guardPage: guardPage
  };
})(window);
