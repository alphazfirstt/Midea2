(function () {
  const { escapeHtml, fmtDateTime, todayISO, daysAgoISO, downloadCSV, toast, dayStartISO, dayEndExclusiveISO } = window.Utils;

  async function render(container, profile) {
    if (profile.role !== "admin") {
      container.innerHTML = `<div class="empty">Access denied</div>`;
      return;
    }

    container.innerHTML = `
      <div class="card">
        <div class="card-title">📋 Activity logs</div>
        <div class="toolbar">
          <input class="input" id="l-search" placeholder="Search description…" />
          <select class="select" id="l-action">
            <option value="">All actions</option>
            <option value="create">Create</option>
            <option value="update">Update</option>
            <option value="archive">Archive</option>
            <option value="restore">Restore</option>
            <option value="approve_user">Approve user</option>
            <option value="reject_user">Reject user</option>
          </select>
          <input class="input" type="date" id="l-from" value="${daysAgoISO(30)}" />
          <input class="input" type="date" id="l-to" value="${todayISO()}" />
          <button class="btn btn-primary btn-sm" id="l-run">Run</button>
          <button class="btn btn-outline btn-sm" id="l-export">⬇ CSV</button>
        </div>
        <div id="logs-table"></div>
      </div>`;

    document.getElementById("l-run").addEventListener("click", loadLogs);
    document.getElementById("l-search").addEventListener("input", window.Utils.debounce(loadLogs, 300));
    document.getElementById("l-action").addEventListener("change", loadLogs);
    document.getElementById("l-from").addEventListener("change", loadLogs);
    document.getElementById("l-to").addEventListener("change", loadLogs);
    document.getElementById("l-export").addEventListener("click", exportLogs);

    await loadLogs();
  }

  let currentRows = [];

  async function loadLogs() {
    const el = document.getElementById("logs-table");
    el.innerHTML = `<div class="spinner" style="margin:0 auto"></div>`;

    const search = document.getElementById("l-search").value.trim();
    const action = document.getElementById("l-action").value;
    const from = document.getElementById("l-from").value;
    const to = document.getElementById("l-to").value;

    let q = window.db.from("activity_logs")
      .select("id,action,table_name,record_id,description,created_at,user_id,profiles:user_id(display_name,email)")
      .order("created_at", { ascending: false })
      .limit(500);
    if (search) q = q.ilike("description", `%${search}%`);
    if (action) q = q.eq("action", action);
    if (from) q = q.gte("created_at", dayStartISO(from));
    if (to) q = q.lt("created_at", dayEndExclusiveISO(to));

    const { data, error } = await q;
    if (error) { el.innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`; return; }
    currentRows = data || [];
    if (!data.length) { el.innerHTML = `<div class="empty">No activity</div>`; return; }

    el.innerHTML = `<div class="table-wrap"><table><thead><tr>
      <th>When</th><th>User</th><th>Action</th><th>Table</th><th>Description</th>
    </tr></thead><tbody>${data.map(r => `<tr>
      <td>${escapeHtml(fmtDateTime(r.created_at))}</td>
      <td>${escapeHtml(r.profiles?.display_name || r.profiles?.email || "—")}</td>
      <td><span class="pill pill-info">${escapeHtml(r.action)}</span></td>
      <td>${escapeHtml(r.table_name || "—")}</td>
      <td>${escapeHtml(r.description || "")}</td>
    </tr>`).join("")}</tbody></table></div>`;
  }

  function exportLogs() {
    if (!currentRows.length) { toast("Run the report first", "warning"); return; }
    const headers = ["When", "User", "Action", "Table", "Description"];
    const rows = currentRows.map(r => [
      fmtDateTime(r.created_at),
      r.profiles?.display_name || r.profiles?.email || "",
      r.action,
      r.table_name || "",
      r.description || ""
    ]);
    downloadCSV(`midea-activity-logs-${todayISO()}.csv`, [headers, ...rows]);
    toast("CSV downloaded", "success");
  }

  window.Router.register("#/logs", render, { title: "Activity Logs", roles: ["admin"] });
})();