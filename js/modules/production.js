(function () {
  const { escapeHtml, toast, fmtDate, todayISO, openModal, showLoading } = window.Utils;
  let modelsCache = [];

  async function render(container, profile) {
    const { data: models } = await window.db.from("models").select("*").eq("is_active", true).order("name");
    modelsCache = models || [];

    container.innerHTML = `
      <div class="card">
        <div class="card-title">🏭 Record production</div>
        <form id="prod-form">
          <div class="form-group"><label>Date</label>
            <input class="input" type="date" name="production_date" value="${todayISO()}" required /></div>
          <div class="form-group"><label>Model</label>
            <select class="select" name="model_id" required>
              <option value="">— Select —</option>
              ${modelsCache.map(m => `<option value="${m.id}">${escapeHtml(m.name)}</option>`).join("")}
            </select></div>
          <div class="form-group"><label>Quantity</label>
            <input class="input" type="number" name="quantity" min="1" step="1" required /></div>
          <div class="form-group"><label>Shift</label>
            <select class="select" name="shift">
              <option value="">—</option>
              <option>A</option><option>B</option><option>C</option>
              <option>Day</option><option>Night</option>
            </select></div>
          <div class="form-group"><label>Notes</label>
            <textarea class="textarea" name="notes"></textarea></div>
          <button class="btn btn-primary" type="submit">Save production</button>
        </form>
      </div>
      <div class="card">
        <div class="card-title">Production records</div>
        <div class="toolbar">
          <input class="input" type="date" id="from" />
          <input class="input" type="date" id="to" />
          <select class="select" id="mfilter"><option value="">All models</option>
            ${modelsCache.map(m => `<option value="${m.id}">${escapeHtml(m.name)}</option>`).join("")}
          </select>
          <button class="btn btn-outline btn-sm" id="refresh">Refresh</button>
        </div>
        <div id="prod-table"></div>
      </div>`;

    document.getElementById("prod-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const fd = window.Utils.getFormData(e.target);
      const qty = parseInt(fd.quantity, 10);
      if (!Number.isInteger(qty) || qty < 1) { toast("Quantity must be at least 1.", "warning"); return; }
      showLoading(true);
      const { error } = await window.db.from("production_records").insert({
        production_date: fd.production_date,
        model_id: fd.model_id,
        quantity: qty,
        shift: fd.shift || null,
        notes: fd.notes || null
      });
      showLoading(false);
      if (error) { toast(error.message, "error"); return; }
      toast("Production saved", "success");
      e.target.reset();
      document.querySelector('#prod-form [name=production_date]').value = todayISO();
      loadTable();
    });

    document.getElementById("refresh").addEventListener("click", loadTable);
    document.getElementById("from").addEventListener("change", loadTable);
    document.getElementById("to").addEventListener("change", loadTable);
    document.getElementById("mfilter").addEventListener("change", loadTable);

    await loadTable();
  }

  async function loadTable() {
    const el = document.getElementById("prod-table");
    const from = document.getElementById("from").value;
    const to = document.getElementById("to").value;
    const mf = document.getElementById("mfilter").value;
    let q = window.db.from("production_records")
      .select("id,production_date,quantity,shift,notes,model_id,models(name),profiles:created_by(display_name)")
      .is("archived_at", null)
      .order("production_date", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(200);
    if (from) q = q.gte("production_date", from);
    if (to) q = q.lte("production_date", to);
    if (mf) q = q.eq("model_id", mf);
    const { data, error } = await q;
    if (error) { el.innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`; return; }
    if (!data.length) { el.innerHTML = `<div class="empty">No records</div>`; return; }
    el.innerHTML = `<div class="table-wrap"><table><thead><tr>
      <th>Date</th><th>Model</th><th>Qty</th><th>Shift</th><th>By</th><th>Notes</th><th></th>
    </tr></thead><tbody>${data.map(r => `<tr>
      <td>${escapeHtml(r.production_date)}</td>
      <td>${escapeHtml(r.models?.name || "—")}</td>
      <td><strong>${escapeHtml(r.quantity)}</strong></td>
      <td>${escapeHtml(r.shift || "—")}</td>
      <td>${escapeHtml(r.profiles?.display_name || "—")}</td>
      <td>${escapeHtml(r.notes || "—")}</td>
      <td><button class="btn btn-outline btn-sm" data-archive="${r.id}">Archive</button></td>
    </tr>`).join("")}</tbody></table></div>`;
    el.querySelectorAll("[data-archive]").forEach(b => {
      b.addEventListener("click", () => {
        window.Utils.confirmDialog("Archive this production record?", async () => {
          const { error: e2 } = await window.db.from("production_records")
            .update({ archived_at: new Date().toISOString(), archived_by: window.currentProfile.id })
            .eq("id", b.dataset.archive);
          if (e2) { toast(e2.message, "error"); return; }
          toast("Archived", "success");
          loadTable();
        }, "Archive");
      });
    });
  }

  window.Router.register("#/production", render, { title: "Production" });
})();