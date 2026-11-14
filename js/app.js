(function () {
  const { escapeHtml } = window.Utils;

  async function boot() {
    const profile = await window.Auth.requireAuthorized();
    if (!profile) return;
    window.currentProfile = profile;

    document.getElementById("user-name").textContent = profile.display_name || profile.email;
    document.getElementById("user-role").textContent = profile.role;

    buildNav(profile.role);
    document.getElementById("logout-btn").addEventListener("click", () => window.Auth.signOut());
    document.getElementById("menu-btn").addEventListener("click", () => {
      document.getElementById("sidebar").classList.toggle("open");
    });

    // dispatch() falls back to the dashboard when the hash is empty/unknown, so a
    // single call is enough (setting the hash as well rendered the first page twice).
    window.Router.dispatch();
  }

  function buildNav(role) {
    const items = [
      { path: "#/dashboard", label: "Dashboard", ico: "📊", roles: ["admin","supervisor"] },
      { path: "#/welding", label: "Welding", ico: "🔧", roles: ["admin","supervisor"] },
      { path: "#/production", label: "Production", ico: "🏭", roles: ["admin","supervisor"] },
      { path: "#/inventory", label: "Inventory", ico: "📦", roles: ["admin","supervisor"] },
      { path: "#/quality", label: "Quality (Red Tag / Rework)", ico: "🚩", roles: ["admin","supervisor"] },
      { path: "#/reports", label: "Reports", ico: "📈", roles: ["admin","supervisor"] },
      { path: "#/users", label: "User Management", ico: "👥", roles: ["admin"] },
      { path: "#/settings", label: "Settings", ico: "⚙️", roles: ["admin"] },
      { path: "#/logs", label: "Activity Logs", ico: "📋", roles: ["admin"] }
    ];
    const nav = document.getElementById("nav");
    nav.innerHTML = items
      .filter(i => i.roles.includes(role))
      .map(i => `<button class="nav-item" data-path="${i.path}">
        <span class="ico">${i.ico}</span>${escapeHtml(i.label)}
      </button>`).join("");
    nav.querySelectorAll(".nav-item").forEach(btn => {
      btn.addEventListener("click", () => { window.location.hash = btn.dataset.path; });
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
