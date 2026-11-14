(function () {
  const { escapeHtml, toast, fmtDateTime, showLoading } = window.Utils;

  async function render(container, profile) {
    if (profile.role !== "admin") {
      container.innerHTML = `<div class="empty">Access denied</div>`;
      return;
    }

    container.innerHTML = `
      <div class="card">
        <div class="card-title">👥 User management</div>
        <div class="toolbar">
          <button class="btn btn-primary btn-sm" data-tab="pending">Pending</button>
          <button class="btn btn-outline btn-sm" data-tab="active">Active</button>
          <button class="btn btn-outline btn-sm" data-tab="all">All</button>
          <div class="spacer"></div>
          <button class="btn btn-outline btn-sm" id="refresh-users">Refresh</button>
        </div>
        <div id="users-table"></div>
      </div>`;

    document.querySelectorAll("[data-tab]").forEach(b => {
      b.addEventListener("click", () => {
        document.querySelectorAll("[data-tab]").forEach(x => {
          x.className = "btn btn-outline btn-sm";
        });
        b.className = "btn btn-primary btn-sm";
        loadUsers(b.dataset.tab);
      });
    });
    document.getElementById("refresh-users").addEventListener("click", () => {
      const activeTab = document.querySelector("[data-tab].btn-primary").dataset.tab;
      loadUsers(activeTab);
    });

    await loadUsers("pending");
  }

  async function loadUsers(tab) {
    const profile = window.currentProfile;
    const el = document.getElementById("users-table");
    el.innerHTML = `<div class="spinner" style="margin:0 auto"></div>`;

    let q = window.db.from("profiles").select("*").order("created_at", { ascending: false });
    if (tab === "pending") q = q.eq("is_authorized", false);
    if (tab === "active") q = q.eq("is_authorized", true).eq("is_active", true);

    const { data, error } = await q;
    if (error) { el.innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`; return; }
    if (!data.length) { el.innerHTML = `<div class="empty">No users</div>`; return; }

    el.innerHTML = `<div class="table-wrap"><table><thead><tr>
      <th>Name</th><th>Email</th><th>Role</th><th>Status</th><th>Created</th><th></th>
    </tr></thead><tbody>${data.map(u => {
      const statusPill = !u.is_authorized ? "pill-warn"
        : !u.is_active ? "pill-danger" : "pill-success";
      const statusText = !u.is_authorized ? "Pending" : !u.is_active ? "Disabled" : "Active";
      return `<tr>
        <td><strong>${escapeHtml(u.display_name)}</strong></td>
        <td>${escapeHtml(u.email)}</td>
        <td><span class="pill ${u.role === "admin" ? "pill-danger" : "pill-info"}">${escapeHtml(u.role)}</span></td>
        <td><span class="pill ${statusPill}">${statusText}</span></td>
        <td>${escapeHtml(fmtDateTime(u.created_at))}</td>
        <td>
          ${!u.is_authorized ? `<button class="btn btn-primary btn-sm" data-approve="${u.id}">Approve</button>` : ""}
          ${!u.is_authorized ? `<button class="btn btn-danger btn-sm" data-reject="${u.id}">Reject</button>` : ""}
          ${u.is_authorized ? `<button class="btn btn-outline btn-sm" data-edit="${u.id}">Edit</button>` : ""}
          ${u.is_authorized && u.is_active && u.id !== profile.id ? `<button class="btn btn-outline btn-sm" data-disable="${u.id}">Disable</button>` : ""}
          ${u.is_authorized && !u.is_active ? `<button class="btn btn-outline btn-sm" data-enable="${u.id}">Enable</button>` : ""}
        </td>
      </tr>`;
    }).join("")}</tbody></table></div>`;

    el.querySelectorAll("[data-approve]").forEach(b => b.addEventListener("click", () => approve(b.dataset.approve, tab)));
    el.querySelectorAll("[data-reject]").forEach(b => b.addEventListener("click", () => reject(b.dataset.reject, tab)));
    el.querySelectorAll("[data-disable]").forEach(b => b.addEventListener("click", () => toggleActive(b.dataset.disable, false, tab)));
    el.querySelectorAll("[data-enable]").forEach(b => b.addEventListener("click", () => toggleActive(b.dataset.enable, true, tab)));
    el.querySelectorAll("[data-edit]").forEach(b => b.addEventListener("click", () => {
      const u = data.find(x => x.id === b.dataset.edit);
      editUser(u, tab);
    }));
  }

  async function approve(id, tab) {
    showLoading(true);
    const { error } = await window.db.rpc("admin_approve_user", { p_user_id: id });
    showLoading(false);
    if (error) { toast(error.message, "error"); return; }
    toast("User approved", "success");
    loadUsers(tab);
  }

  async function reject(id, tab) {
    window.Utils.confirmDialog("Reject this user?", async () => {
      showLoading(true);
      const { error } = await window.db.rpc("admin_reject_user", { p_user_id: id });
      showLoading(false);
      if (error) { toast(error.message, "error"); return; }
      toast("User rejected", "success");
      loadUsers(tab);
    }, "Reject");
  }

  async function toggleActive(id, active, tab) {
    if (!active && id === window.currentProfile.id) { toast("You cannot disable your own account.", "warning"); return; }
    showLoading(true);
    const { error } = await window.db.from("profiles").update({ is_active: active }).eq("id", id);
    showLoading(false);
    if (error) { toast(error.message, "error"); return; }
    toast(active ? "User enabled" : "User disabled", "success");
    loadUsers(tab);
  }

  function editUser(u, tab) {
    window.Utils.openModal({
      title: `Edit user — ${u.display_name}`,
      bodyHtml: `
        <div class="form-group"><label>Full name</label>
          <input class="input" name="display_name" value="${escapeHtml(u.display_name)}" required /></div>
        <div class="form-group"><label>Role</label>
          <select class="select" name="role" ${u.id === window.currentProfile.id ? "disabled" : ""}>
            <option value="supervisor" ${u.role === "supervisor" ? "selected" : ""}>Supervisor</option>
            <option value="admin" ${u.role === "admin" ? "selected" : ""}>Administrator</option>
          </select></div>
      `,
      saveLabel: "Save",
      onSave: async (fd, close) => {
        const name = (fd.display_name || "").trim();
        if (!name) { toast("Name is required.", "warning"); return; }
        const changes = { display_name: name };
        // A disabled <select> isn't submitted, so an admin can never demote themselves (lock-out).
        if (u.id !== window.currentProfile.id && fd.role) changes.role = fd.role;
        const { error } = await window.db.from("profiles").update(changes).eq("id", u.id);
        if (error) { toast(error.message, "error"); return; }
        toast("Saved", "success");
        close();
        loadUsers(tab);
      }
    });
  }

  window.Router.register("#/users", render, { title: "User Management", roles: ["admin"] });
})();