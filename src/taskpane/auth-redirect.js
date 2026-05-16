/**
 * Pivot — MSAL popup redirect handler.
 *
 * Runs only inside the sign-in popup window after AAD redirects back with
 * an authorization code / hash. It rebuilds a tiny MSAL instance using the
 * same runtime config as the main taskpane, invokes
 * handleRedirectPromise(), which causes MSAL.js to detect the popup
 * context and post the auth result to the opener window — then we close
 * ourselves so the parent UI returns to the user immediately without
 * having to wait for the entire taskpane bundle to load inside the popup.
 */

(async function () {
  const log = (...args) => console.log("[auth-redirect]", ...args);

  async function loadRuntimeConfig() {
    try {
      const res = await fetch("/api/runtime-config", { credentials: "same-origin" });
      if (res.ok) return await res.json();
    } catch (err) {
      log("runtime-config fetch failed:", err.message);
    }
    return {};
  }

  try {
    const msal = await import("@azure/msal-browser");
    const cfg = await loadRuntimeConfig();
    if (!cfg.clientId) {
      log("no clientId in runtime-config; popup cannot complete handshake");
      return;
    }

    const instance = new msal.PublicClientApplication({
      auth: {
        clientId: cfg.clientId,
        authority: `https://login.microsoftonline.com/${cfg.tenantId || "common"}`,
        redirectUri: window.location.origin + window.location.pathname,
      },
      cache: {
        cacheLocation: "localStorage",
        storeAuthStateInCookie: false,
      },
    });

    if (typeof instance.initialize === "function") {
      await instance.initialize();
    }

    // handleRedirectPromise() routes the auth result back to the parent
    // (via the shared cache + window.opener.postMessage that MSAL handles
    // internally) and resolves on this side once posting is done.
    await instance.handleRedirectPromise();
  } catch (err) {
    log("redirect handler error:", err && err.message ? err.message : err);
  } finally {
    // Whether or not MSAL is happy, try to close so the user isn't stuck
    // staring at this page. The opener (taskpane) is responsible for
    // surfacing any error to the user.
    try { window.close(); } catch { /* ignore */ }
  }
})();
