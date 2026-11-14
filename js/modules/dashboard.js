(function () {
  const { todayISO, fmtDateTime, escapeHtml, dayStartISO } = window.Utils;

  async function loadDashboard(container, profile) {
    container.innerHTML = `<div class="empty"><div class="spinner" style="margin:0 auto"></div><p>Loading dashboard…</p></div>`;
    const today = todayISO();
    const db = window.db;

    const [
      prodToday, weldToday, weldTotal, redTags, reworks,
      stock, pendingUsers, recentWelds, recentProd, recentLogs
    ] = await Promise.all([
      db.from("production_records").select("quantity,model_id").eq("production_date", today).is("archived_at", null),
      db.from("fridge_weld_records").select("id", { count: "exact", head: true }).gte("welded_at", dayStartISO(today)).is("archived_at", null),
      db.from("fridge_weld_records").select("id", { count: "exact", head: true }).is("archived_at", null),
      db.from("quality_records").select("id", { count: "exact", head: true }).eq("record_type", "Red Tag").in("status", ["Open", "In Progress"]).is("archived_at", null),
      db.from("quality_records").select("id", { count: "exact", head: true }).eq("record_type", "Rework").in("status", ["Open", "In Progress"]).is("archived_at", null),
      db.from("material_stock").select("*"),
      profile.role === "admin" ? db.from("profiles").select("id", { count: "exact", head: true }).eq("is_authorized", false) : Promise.resolve({ count: 0 }),
      db.from("fridge_weld_records")
        .select("serial_number,welded_at,model_id,models(name),profiles:created_by(display_name)")
        .is("archived_at", null).order("welded_at", { ascending: false }).limit(8),
      db.from("production_records")
        .select("quantity,production_date,shift,models(name),profiles:created_by(display_name)")
        .is("archived_at", null).order("created_at", { ascending: false }).limit(8),
      profile.role === "admin"
        ? db.from("activity_logs").select("*").order("created_at", { ascending: false }).limit(8)
        : db.from("activity_logs").select("*").eq("user_id", profile.id).order("created_at", { ascending: false }).limit(8)
    ]);

    const prodTotal = (prodToday.data || []).reduce((s, r) => s + (r.quantity || 0), 0);
    const copper = (stock.data || []).find(s => s.material_name === "Copper Rod");
    const silver = (stock.data || []).find(s => s.material_name === "Silver Rod");

    const stats = [
      { label: "Today's Production", value: prodTotal, sub: "units", cls: "accent" },
      { label: "Today's Welds", value: weldToday.count ?? 0, sub: "refrigerators", cls: "success" },
      { label: "Total Welds", value: weldTotal.count ?? 0, sub: "all time", cls: "" },
      { label: "Red Tags", value: redTags.count ?? 0, sub: "open issues", cls: "danger" },
      { label: "Reworks", value: reworks.count ?? 0, sub: "open issues", cls: "warning" },
      { label: "Copper Stock", value: Number(copper?.current_stock ?? 0).toFixed(2), sub: "kg", cls: "" },
      { label: "Silver Stock", value: Number(silver?.current_stock ?? 0).toFixed(2), sub: "kg", cls: "" }
    ];
    if (profile.role === "admin") {
      stats.push({ label: "Pending Users", value: pendingUsers.count ?? 0, sub: "awaiting approval", cls: "warning" });
    }

    const statHtml = stats.map(s => `
      <div class="stat ${s.cls}">
        <div class="label">${escapeHtml(s.label)}</div>
        <div class="value">${escapeHtml(String(s.value))}</div>
        <div class="sub">${escapeHtml(s.sub)}</div>
      </div>`).join("");

    container.innerHTML = `
      <div class="stats-grid">${statHtml}</div>
      <div class="card" style="margin-top:16px">
        <div class="card-title">Recent Welding Registrations</div>
        ${renderRecentWelds(recentWelds.data || [])}
      </div>
      <div class="card">
        <div class="card-title">Recent Production</div>
        ${renderRecentProd(recentProd.data || [])}
      </div>
      <div class="card">
        <div class="card-title">Recent Activity</div>
        ${renderRecentLogs(recentLogs.data || [])}
      </div>`;
  }

  function renderRecentWelds(rows) {
    if (!rows.length) return `<div class="empty">No recent welds</div>`;
    return `<div class="table-wrap"><table><thead><tr>
      <th>Serial</th><th>Model</th><th>By</th><th>When</th>
    </tr></thead><tbody>${rows.map(r => `<tr>
      <td><strong>${escapeHtml(r.serial_number)}</strong></td>
      <td>${escapeHtml(r.models?.name || "—")}</td>
      <td>${escapeHtml(r.profiles?.display_name || "—")}</td>
      <td>${escapeHtml(fmtDateTime(r.welded_at))}</td>
    </tr>`).join("")}</tbody></table></div>`;
  }
  function renderRecentProd(rows) {
    if (!rows.length) return `<div class="empty">No production yet</div>`;
    return `<div class="table-wrap"><table><thead><tr>
      <th>Date</th><th>Model</th><th>Qty</th><th>Shift</th><th>By</th>
    </tr></thead><tbody>${rows.map(r => `<tr>
      <td>${escapeHtml(r.production_date)}</td>
      <td>${escapeHtml(r.models?.name || "—")}</td>
      <td>${escapeHtml(r.quantity)}</td>
      <td>${escapeHtml(r.shift || "—")}</td>
      <td>${escapeHtml(r.profiles?.display_name || "—")}</td>
    </tr>`).join("")}</tbody></table></div>`;
  }
  function renderRecentLogs(rows) {
    if (!rows.length) return `<div class="empty">No activity</div>`;
    return `<div class="table-wrap"><table><thead><tr>
      <th>When</th><th>Action</th><th>Table</th><th>Description</th>
    </tr></thead><tbody>${rows.map(r => `<tr>
      <td>${escapeHtml(fmtDateTime(r.created_at))}</td>
      <td><span class="pill pill-info">${escapeHtml(r.action)}</span></td>
      <td>${escapeHtml(r.table_name || "—")}</td>
      <td>${escapeHtml(r.description || "")}</td>
    </tr>`).join("")}</tbody></table></div>`;
  }

  window.Router.register("#/dashboard", loadDashboard, { title: "Dashboard" });
})();
