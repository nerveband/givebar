/* Givebar operator sessions: HttpOnly cookie auth, never readable PINs. */
(function () {
  async function api(path, options = {}) {
    const headers = new Headers(options.headers || {});
    if (!headers.has("Cache-Control")) headers.set("Cache-Control", "no-cache");
    const response = await fetch(path, { credentials: "same-origin", ...options, headers });
    if (response.status === 401 && !location.pathname.endsWith("/signin.html")) {
      location.replace("/signin.html?next=" + encodeURIComponent(location.pathname));
      throw new Error("Operator sign-in required");
    }
    return response;
  }

  async function logout() {
    await api("/api/control", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "logout" })
    });
    location.replace("/signin.html");
  }

  window.GivebarSession = { api, logout };
})();
