(function () {
  const routes = [];
  function register(path, handler, opts = {}) {
    routes.push({ path, handler, roles: opts.roles || null, title: opts.title || "", cleanup: opts.cleanup || null });
  }
  function navigate(path) {
    if (window.location.hash !== path) window.location.hash = path;
    else dispatch();
  }
  let activeRoute = null;
  let dispatchToken = 0;

  async function dispatch() {
    const hash = window.location.hash || "#/dashboard";
    const route = routes.find(r => hash === r.path) || routes.find(r => r.path === "#/dashboard");
    if (!route) return;
    // Leaving a page: let it release resources (e.g. the camera) before the next page renders.
    if (activeRoute && activeRoute.cleanup) {
      try { await activeRoute.cleanup(); } catch (e) { console.warn("route cleanup failed", e); }
    }
    activeRoute = null;
    const token = ++dispatchToken;
    if (route.roles && (!window.currentProfile || !route.roles.includes(window.currentProfile.role))) {
      window.Utils.toast("You do not have access to that page.", "warning");
      window.location.hash = "#/dashboard";
      return;
    }
    if (hash !== route.path) {
      // Unknown URL: fall back to the dashboard without leaving a bogus hash in the address bar.
      history.replaceState(null, "", route.path);
    }
    document.querySelectorAll(".nav-item").forEach(el => {
      el.classList.toggle("active", el.dataset.path === route.path);
    });
    document.getElementById("topbar-title").textContent = route.title;
    document.getElementById("sidebar").classList.remove("open");
    const container = document.getElementById("view");
    container.innerHTML = "";
    activeRoute = route;
    try {
      await route.handler(container, window.currentProfile);
    } catch (e) {
      console.error(e);
      if (token !== dispatchToken) return; // user already navigated elsewhere
      container.innerHTML = `<div class="empty"><div class="big">⚠️</div><p>Failed to load page.</p><p style="color:#999;font-size:13px">${window.Utils.escapeHtml(e.message || "")}</p></div>`;
    }
  }
  window.addEventListener("hashchange", dispatch);
  window.Router = { register, navigate, dispatch };
})();