/**
 * Ledgerlens — MSAL-based authentication service.
 * Handles user sign-in via Microsoft Entra ID and token management
 * for accessing Microsoft Graph and custom data connectors.
 */

const LOGIN_SCOPES = ["User.Read", "openid", "profile"];

function getErrorMessage(err, fallback) {
  if (!err) return fallback;
  if (typeof err === "string") return err;
  if (err instanceof Error && err.message) return err.message;
  const code = err.errorCode || err.code;
  const message = err.message || err.errorMessage || err.toString?.();
  if (code && message && message !== "[object Object]") return `${code}: ${message}`;
  if (message && message !== "[object Object]") return message;
  if (code) return String(code);
  try {
    const json = JSON.stringify(err);
    if (json && json !== "{}") return json;
  } catch {
    // Ignore serialization failures and return the fallback.
  }
  return fallback;
}

async function loadRuntimeConfig() {
  let runtimeConfig = {
    clientId: "YOUR_APP_CLIENT_ID",
    tenantId: "common",
    redirectUri: window.location.origin + "/taskpane.html",
    appIdUri: "",
    apiScope: "",
    naaEnabled: false,
  };

  try {
    const response = await fetch("/api/runtime-config", { credentials: "same-origin" });
    if (response.ok) {
      const payload = await response.json();
      runtimeConfig = {
        clientId: payload.clientId || runtimeConfig.clientId,
        tenantId: payload.tenantId || runtimeConfig.tenantId,
        redirectUri: payload.redirectUri || runtimeConfig.redirectUri,
        appIdUri: payload.appIdUri || runtimeConfig.appIdUri,
        apiScope: payload.apiScope || runtimeConfig.apiScope,
        naaEnabled: payload.naaEnabled === true,
      };
    }
  } catch {
    // Use defaults when runtime config can't be fetched.
  }

  if (!runtimeConfig.appIdUri && runtimeConfig.clientId && runtimeConfig.clientId !== "YOUR_APP_CLIENT_ID") {
    runtimeConfig.appIdUri = `api://${runtimeConfig.clientId}`;
  }
  if (!runtimeConfig.apiScope && runtimeConfig.appIdUri) {
    runtimeConfig.apiScope = `${runtimeConfig.appIdUri}/access_as_user`;
  }

  return runtimeConfig;
}

async function loadMsalConfig() {
  const runtimeConfig = await loadRuntimeConfig();

  // We always navigate the sign-in popup to a dedicated minimal redirect
  // page rather than the heavy taskpane bundle — see auth-redirect.js. The
  // page lives on the same origin so MSAL's cross-window cache + close
  // workflow continues to work.
  const redirectUri = window.location.origin + "/auth-redirect.html";

  return {
    auth: {
      clientId: runtimeConfig.clientId,
      authority: `https://login.microsoftonline.com/${runtimeConfig.tenantId}`,
      redirectUri,
    },
    cache: {
      cacheLocation: "localStorage",
      storeAuthStateInCookie: false,
    },
  };
}

class AuthService {
  constructor() {
    this._msalInstance = null;
    this._standardMsalInstance = null;
    this._account = null;
    this._initialized = false;
    this._runtimeConfig = null;
    this._msalLib = null;
  }

  async getRuntimeConfig() {
    if (!this._runtimeConfig) {
      this._runtimeConfig = await loadRuntimeConfig();
    }
    return this._runtimeConfig;
  }

  async initialize() {
    if (this._initialized) return;
    const msal = await import("@azure/msal-browser");
    this._msalLib = msal;
    const msalConfig = await loadMsalConfig();
    const runtimeConfig = await this.getRuntimeConfig();
    this._msalInstance = runtimeConfig.naaEnabled
      ? await msal.createNestablePublicClientApplication(msalConfig)
      : new msal.PublicClientApplication(msalConfig);

    if (typeof this._msalInstance.initialize === "function") {
      await this._msalInstance.initialize();
    }

    // MSAL requires handleRedirectPromise() to be invoked on every page
    // load to settle any in-flight redirect / popup auth response from a
    // previous navigation. Skipping it leaves the popup-close handshake
    // half-finished and lets stale auth state pile up in cache.
    try {
      await this._msalInstance.handleRedirectPromise();
    } catch {
      // Non-fatal: any in-flight error is reported when the next
      // acquireToken call runs.
    }

    const accounts = this._msalInstance.getAllAccounts();
    if (accounts.length > 0) {
      this._account = accounts[0];
    }
    this._initialized = true;
  }

  async getStandardMsalInstance() {
    if (this._standardMsalInstance) {
      return this._standardMsalInstance;
    }

    const msalConfig = await loadMsalConfig();
    this._standardMsalInstance = new this._msalLib.PublicClientApplication(msalConfig);
    await this._standardMsalInstance.initialize();

    const accounts = this._standardMsalInstance.getAllAccounts();
    if (!this._account && accounts.length > 0) {
      this._account = accounts[0];
    }

    return this._standardMsalInstance;
  }

  get isSignedIn() {
    return !!this._account;
  }

  get user() {
    if (!this._account) return null;
    return {
      name: this._account.name,
      email: this._account.username,
      id: this._account.homeAccountId,
    };
  }

  async signIn() {
    await this.initialize();

    const runtimeConfig = await this.getRuntimeConfig();
    if (!runtimeConfig.clientId || runtimeConfig.clientId === "YOUR_APP_CLIENT_ID") {
      throw new Error(
        "Sign-in is not configured: the server is missing LEDGERLENS_CLIENT_ID. Set it on the App Service and reload."
      );
    }

    if (runtimeConfig.naaEnabled) {
      // NAA flow uses the existing Office identity — no popup needed.
      await this.acquireNaaToken(LOGIN_SCOPES);
      return this.user;
    }

    // Standard MSAL.js flow: try silent if we already have a cached account,
    // otherwise pop the sign-in window directly. getToken() throws on no
    // account, so we can't use it for the first-time sign-in path.
    if (this._account) {
      try {
        const silent = await this._msalInstance.acquireTokenSilent({
          scopes: LOGIN_SCOPES,
          account: this._account,
        });
        this._account = silent?.account || this._account;
        return this.user;
      } catch {
        // fall through to interactive
      }
    }

    const result = await this._msalInstance.acquireTokenPopup({ scopes: LOGIN_SCOPES });
    this._account = result?.account || this._account;
    return this.user;
  }

  async signOut() {
    if (!this._msalInstance) return;
    await this._msalInstance.logoutPopup({ account: this._account });
    this._account = null;
  }

  async getLoginHint() {
    try {
      if (typeof Office !== "undefined" && Office.auth?.getAuthContext) {
        const authContext = await Office.auth.getAuthContext();
        if (authContext?.userPrincipalName) {
          return authContext.userPrincipalName;
        }
      }
    } catch {
      // Ignore login hint lookup failures and let MSAL continue without it.
    }
    return null;
  }

  isNaaSupported() {
    try {
      return typeof Office !== "undefined"
        && !!Office.context?.requirements
        && Office.context.requirements.isSetSupported("NestedAppAuth", "1.1");
    } catch {
      return false;
    }
  }

  async acquireStandardToken(scopes) {
    await this.initialize();
    const standardMsal = await this.getStandardMsalInstance();

    const silentRequest = {
      scopes,
      loginHint: await this.getLoginHint(),
      account: this._account || undefined,
    };

    try {
      if (silentRequest.account) {
        const silentResult = await standardMsal.acquireTokenSilent(silentRequest);
        this._account = silentResult?.account || this._account;
        if (silentResult?.accessToken) {
          return silentResult.accessToken;
        }
      }
    } catch {
      // Continue to interactive fallback.
    }

    const popupResult = await standardMsal.acquireTokenPopup(silentRequest);
    this._account = popupResult?.account || this._account;
    if (!popupResult?.accessToken) {
      throw new Error("Could not acquire an access token through the MSAL popup flow.");
    }
    return popupResult.accessToken;
  }

  async acquireNaaToken(scopes) {
    const runtimeConfig = await this.getRuntimeConfig();
    if (!runtimeConfig.apiScope) {
      throw new Error("NAA is enabled, but the API scope is not configured.");
    }

    await this.initialize();

    if (!this.isNaaSupported()) {
      return this.acquireStandardToken(scopes);
    }

    const request = {
      scopes,
      loginHint: await this.getLoginHint(),
      account: this._account || undefined,
    };

    let authResult = null;
    try {
      if (request.account && typeof this._msalInstance.acquireTokenSilent === "function") {
        authResult = await this._msalInstance.acquireTokenSilent(request);
      }
      if (!authResult) {
        authResult = await this._msalInstance.ssoSilent(request);
      }
    } catch (err) {
      const interactionRequired = err instanceof this._msalLib.InteractionRequiredAuthError
        || ["interaction_required", "login_required", "consent_required", "no_tokens_found"].includes(err?.errorCode);
      if (interactionRequired) {
        try {
          authResult = await this._msalInstance.acquireTokenPopup(request);
        } catch (popupErr) {
          return this.acquireStandardToken(scopes);
        }
      } else {
        return this.acquireStandardToken(scopes);
      }
    }

    this._account = authResult?.account || this._account;
    if (!authResult?.accessToken) {
      throw new Error("Could not acquire a Nested App Authentication access token.");
    }
    return authResult.accessToken;
  }

  async getApiToken() {
    const runtimeConfig = await this.getRuntimeConfig();

    if (!runtimeConfig.naaEnabled) {
      return null;
    }

    try {
      return await this.acquireNaaToken([runtimeConfig.apiScope]);
    } catch (err) {
      throw new Error(getErrorMessage(err, "Unable to acquire API token through Nested App Authentication."));
    }
  }

  async fetchApi(input, init = {}) {
    const token = await this.getApiToken();
    const headers = new Headers(init.headers || {});
    if (token) {
      headers.set("Authorization", `Bearer ${token}`);
    }
    return fetch(input, { ...init, headers });
  }

  /**
   * Acquire a token silently (or via popup fallback) for a given set of scopes.
   * Connectors call this to get bearer tokens for their APIs.
   */
  async getToken(scopes) {
    await this.initialize();

    const runtimeConfig = await this.getRuntimeConfig();
    if (runtimeConfig.naaEnabled) {
      return this.acquireNaaToken(scopes);
    }

    if (!this._account) throw new Error("User not signed in");

    const request = { scopes, account: this._account };
    try {
      const response = await this._msalInstance.acquireTokenSilent(request);
      return response.accessToken;
    } catch {
      const response = await this._msalInstance.acquireTokenPopup(request);
      this._account = response.account;
      return response.accessToken;
    }
  }
}

// Singleton
const authService = new AuthService();
export default authService;
