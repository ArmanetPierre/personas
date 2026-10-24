// Page /device du Hub : valide la connexion de `personas hub login`. Seule page avec JavaScript (CSP :
// script-src 'self', connect-src 'self' + Supabase). Connexion par Supabase Auth (lien magique sans
// création de compte, ou GitHub) ; le jeton d'accès reste dans sessionStorage, le temps de la validation.
(() => {
  "use strict";
  const root = document.getElementById("device");
  if (!root) return;
  const SB = (root.dataset.supabaseUrl || "").replace(/\/+$/, "");
  const KEY = root.dataset.anonKey || "";
  const REDIRECT = root.dataset.redirect || location.origin + "/device";
  const STORE = "hub_sb_session";
  const $ = (id) => document.getElementById(id);
  const show = (id, on) => {
    const el = $(id);
    if (el) el.hidden = !on;
  };
  let M = {};
  try {
    M = JSON.parse(root.dataset.messages || "{}");
  } catch {
    /* messages absents : repli sur le message générique */
  }
  const msg = (key) => M[key] || M.generic || key;
  const codeEl = $("user-code");
  const HINT = "user-code-hint";
  // Zone d'annonce (role=alert) présente dès le chargement : on change son contenu, sans la masquer.
  const errorBox = $("error");
  const setFieldError = (on) => {
    if (on) codeEl.setAttribute("aria-invalid", "true");
    else codeEl.removeAttribute("aria-invalid");
    codeEl.setAttribute("aria-describedby", on ? `${HINT} error` : HINT);
  };
  /** Affiche un message traduit ; `field` : l'erreur concerne le code saisi. */
  const fail = (text, field) => {
    errorBox.textContent = `${errorBox.dataset.prefix} ${text}`;
    setFieldError(Boolean(field));
  };
  const clearError = () => {
    errorBox.textContent = "";
    setFieldError(false);
  };
  /** Erreur traduite, portant éventuellement sur le champ du code. */
  class UiError extends Error {
    constructor(key, field) {
      super(msg(key));
      this.field = Boolean(field);
    }
  }
  const STATE_KEYS = { expired: "expired", consumed: "consumed", denied: "denied", approved: "approved" };
  /** Erreur de l'API → message traduit, d'après error.reason (stable), puis error.code et le statut HTTP. */
  const apiError = (status, err) => {
    const reason = (err && err.reason) || "";
    if (reason === "unknown_code") return new UiError("unknownCode", true);
    if (STATE_KEYS[reason]) return new UiError(STATE_KEYS[reason], true);
    if (reason === "already_decided") return new UiError("alreadyDecided", true);
    if (status === 401) return new UiError("session");
    if (status === 403) return new UiError("forbidden");
    if (status === 429 || (err && err.code === "rate_limited")) return new UiError("rateLimited");
    if (status === 404) return new UiError("unknownCode", true);
    if (status === 410) return new UiError("expired", true);
    if (status === 409) return new UiError("alreadyDecided", true);
    return new UiError("generic");
  };
  const failWith = (e) => (e instanceof UiError ? fail(e.message, e.field) : fail(msg("network")));

  /** Désactive les boutons pendant l'appel (aria-busy, libellé d'attente) ; ignore un second envoi. */
  let inFlight = false;
  async function busy(buttons, label, fn) {
    if (inFlight) return;
    inFlight = true;
    const saved = buttons.map((b) => b.textContent);
    buttons.forEach((b, i) => {
      b.disabled = true;
      b.setAttribute("aria-busy", "true");
      if (i === 0 && label) b.textContent = label;
    });
    try {
      await fn();
    } finally {
      buttons.forEach((b, i) => {
        b.disabled = false;
        b.removeAttribute("aria-busy");
        b.textContent = saved[i];
      });
      inFlight = false;
    }
  }
  const focusOn = (id) => {
    const el = $(id);
    if (el) el.focus();
  };

  // Retour de Supabase : jetons (ou erreur) dans le fragment de l'URL, retirés aussitôt de l'adresse.
  const frag = new URLSearchParams(location.hash.slice(1));
  if (frag.get("access_token")) {
    const expiresIn = Number(frag.get("expires_in") || 3600);
    try {
      sessionStorage.setItem(STORE, JSON.stringify({ token: frag.get("access_token"), exp: Date.now() / 1000 + expiresIn }));
    } catch {
      /* stockage indisponible : la session vaut pour cette page */
    }
    window.__hubToken = frag.get("access_token");
  }
  if (location.hash) history.replaceState(null, "", location.pathname + location.search);
  const fragError = frag.get("error_description") || frag.get("error");

  const token = () => {
    if (window.__hubToken) return window.__hubToken;
    try {
      const s = JSON.parse(sessionStorage.getItem(STORE) || "null");
      if (s && s.exp > Date.now() / 1000 + 30) return s.token;
      sessionStorage.removeItem(STORE);
    } catch {
      /* rien */
    }
    return null;
  };

  const code = () => codeEl.value.trim().toUpperCase();
  const backUrl = () => `${REDIRECT}?code=${encodeURIComponent(code())}`;

  const render = () => {
    const signed = Boolean(token());
    show("signin", !signed);
    show("session", signed);
  };

  async function api(path, body) {
    const r = await fetch(path, { method: "POST", headers: { Authorization: `Bearer ${token()}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const json = await r.json().catch(() => ({}));
    if (!r.ok) {
      if (r.status === 401 || r.status === 403) {
        try {
          sessionStorage.removeItem(STORE);
        } catch {
          /* rien */
        }
        window.__hubToken = null;
        render();
        // #session vient d'être masqué avec le bouton focalisé : le focus passe au titre de connexion.
        focusOn("signin-title");
      }
      throw apiError(r.status, json.error);
    }
    return json;
  }

  function check() {
    if (inFlight) return;
    clearError();
    show("request", false);
    if (!code()) {
      fail(msg("emptyCode"), true);
      codeEl.focus();
      return;
    }
    return busy([$("check")], msg("checking"), async () => {
      try {
        const info = await api("/v1/device/lookup", { user_code: code() });
        if (info.state !== "pending") throw new UiError(STATE_KEYS[info.state] || "generic", true);
        $("r-client").textContent = info.clientName;
        $("r-scopes").textContent = info.scopes.join(", ");
        $("r-expires").textContent = new Date(info.expiresAt).toLocaleString(root.dataset.ui === "fr" ? "fr-FR" : "en-GB");
        show("request", true);
      } catch (e) {
        failWith(e);
      }
    });
  }

  function decide(approve) {
    if (inFlight) return;
    clearError();
    const buttons = approve ? [$("approve"), $("deny")] : [$("deny"), $("approve")];
    return busy(buttons, msg(approve ? "approving" : "denying"), async () => {
      try {
        await api("/v1/device/approve", { user_code: code(), approve });
        show("session", false);
        show("signin", false);
        show("code-form", false);
        const done = approve ? "done-ok" : "done-no";
        show(done, true);
        // Le bouton focalisé vient d'être masqué : le focus suit le message de résultat.
        focusOn(done);
      } catch (e) {
        failWith(e);
      }
    });
  }

  // Bouton « Vérifier le code » (submit) et touche Entrée : même chemin. Sans session, on renvoie
  // vers la connexion (le code saisi est conservé dans l'adresse de retour).
  $("code-form").addEventListener("submit", (e) => {
    e.preventDefault();
    if (token()) check();
    else {
      fail(msg("signInFirst"));
      focusOn("signin-title");
    }
  });
  $("github").addEventListener("click", () => {
    location.href = `${SB}/auth/v1/authorize?provider=github&redirect_to=${encodeURIComponent(backUrl())}`;
  });
  const emailForm = $("email-form");
  if (emailForm)
    emailForm.addEventListener("submit", (e) => {
      e.preventDefault();
      if (inFlight) return;
      clearError();
      busy([emailForm.querySelector("button[type=submit]")], msg("sending"), async () => {
        try {
          // create_user: false : comptes sur invitation, aucune inscription depuis le Hub
          const r = await fetch(`${SB}/auth/v1/otp?redirect_to=${encodeURIComponent(backUrl())}`, {
            method: "POST",
            headers: { apikey: KEY, "Content-Type": "application/json" },
            body: JSON.stringify({ email: $("email").value.trim(), create_user: false }),
          });
          if (!r.ok) {
            const j = await r.json().catch(() => ({}));
            const detail = j.msg || j.error_description || j.message || "";
            if (/signup|not allowed|not found/i.test(detail)) throw new UiError("invite");
            throw new UiError(r.status === 429 ? "rateLimited" : "sendLink");
          }
          show("link-sent", true);
        } catch (err) {
          failWith(err);
        }
      });
    });
  $("signout").addEventListener("click", () => {
    try {
      sessionStorage.removeItem(STORE);
    } catch {
      /* rien */
    }
    window.__hubToken = null;
    show("request", false);
    clearError();
    render();
    // #session (qui contenait le bouton) est masqué : le focus passe au titre de connexion.
    focusOn("signin-title");
  });
  $("approve").addEventListener("click", () => decide(true));
  $("deny").addEventListener("click", () => decide(false));

  render();
  if (fragError) fail(/signup|not allowed/i.test(fragError) ? msg("invite") : msg("generic"));
  else if (token() && code()) check();
})();
