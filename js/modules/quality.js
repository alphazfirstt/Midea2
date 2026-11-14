(function () {
  const { escapeHtml, toast, fmtDateTime, todayISO, openModal, showLoading, dayStartISO } = window.Utils;
  let modelsCache = [];

  async function render(container) {
    const { data: models } = await window.db.from("models").select("*").eq("is_active", true).order("name");
    modelsCache = models || [];

    container.innerHTML = `
      <div class="card">
        <div class="card-title">🚩 Record quality issue</div>
        <form id="q-form">
          <div class="form-group"><label>Serial number</label>
            <input class="input" name="serial_number" required /></div>
          <div class="form-group"><label>Model</label>
            <select class="select" name="model_id">
              <option value="">—</option>
              ${modelsCache.map(m => `<option value="${m.id}">${escapeHtml(m.name)}</option>`).join("")}
            </select></div>
          <div class="form-group"><label>Type</label>
            <select class="select" name="record_type" required>
              <option value="">— Select —</option>
              <option>Red Tag</option>
              <option>Rework</option>
            </select></div>
          <div class="form-group"><label>Problem description</label>
            <textarea class="textarea" name="problem_description" required></textarea></div>
          <div class="form-group"><label>Repair action</label>
            <textarea class="textarea" name="repair_action"></textarea></div>
          <div class="form-group"><label>Status</label>
            <select class="select" name="status">
              <option>Open</option>
              <option>In Progress</option>
              <option>Repaired</option>
              <option>Scrapped</option>
              <option>Closed</option>
            </select></div>
          <div class="form-group"><label>Responsible person</label>
            <input class="input" name="responsible_person" /></div>
          <div class="form-group"><label>Notes</label>
            <textarea class="textarea" name="notes"></textarea></div>
          <button class="btn btn-primary" type="submit">Save record</button>
        </form>
      </div>

      <div class="card">
        <div class="card-title">Quality records</div>
        <div class="toolbar">
          <input class="input" id="q-search" placeholder="Search serial…" />
          <select class="select" id="q-type">
            <option value="">All types</option>
            <option>Red Tag</option>
            <option>Rework</option>
          </select>
          <select class="select" id="q-status">
            <option value="">All statuses</option>
            <option>Open</option><option>In Progress</option>
            <option>Repaired</option><option>Scrapped</option><option>Closed</option>
          </select>
          <input class="input" type="date" id="q-from" />
          <button class="btn btn-outline btn-sm" id="q-refresh">Refresh</button>
        </div>
        <div id="q-table"></div>
      </div>`;

    document.getElementById("q-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const fd = window.Utils.getFormData(e.target);
      if (!fd.serial_number.trim()) { toast("Serial number is required.", "warning"); return; }
      showLoading(true);
      const { error } = await window.db.from("quality_records").insert({
        serial_number: fd.serial_number.trim().toUpperCase(),
        model_id: fd.model_id || null,
        record_type: fd.record_type,
        problem_description: fd.problem_description,
        repair_action: fd.repair_action || null,
        status: fd.status || "Open",
        responsible_person: fd.responsible_person || null,
        notes: fd.notes || null,
        recorded_at: new Date().toISOString()
      });
      showLoading(false);
      if (error) { toast(error.message, "error"); return; }
      toast("Record saved", "success");
      e.target.reset();
      loadTable();
    });

    document.getElementById("q-search").addEventListener("input", window.Utils.debounce(loadTable, 300));
    document.getElementById("q-type").addEventListener("change", loadTable);
    document.getElementById("q-status").addEventListener("change", loadTable);
    document.getElementById("q-from").addEventListener("change", loadTable);
    document.getElementById("q-refresh").addEventListener("click", loadTable);

    await loadTable();
  }

  async function loadTable() {
    const el = document.getElementById("q-table");
    const search = (document.getElementById("q-search")?.value || "").trim();
    const type = document.getElementById("q-type")?.value || "";
    const status = document.getElementById("q-status")?.value || "";
    const from = document.getElementById("q-from")?.value || "";

    let q = window.db.from("quality_records")
      .select("id,serial_number,record_type,problem_description,repair_action,status,responsible_person,recorded_at,created_by,models(name),profiles:created_by(display_name)")
      .is("archived_at", null)
      .order("recorded_at", { ascending: false })
      .limit(200);
    if (search) q = q.ilike("serial_number", `%${search}%`);
    if (type) q = q.eq("record_type", type);
    if (status) q = q.eq("status", status);
    if (from) q = q.gte("recorded_at", dayStartISO(from));

    const { data, error } = await q;
    if (error) { el.innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`; return; }
    if (!data.length) { el.innerHTML = `<div class="empty">No records</div>`; return; }

    const isAdmin = window.currentProfile.role === "admin";
    el.innerHTML = `<div class="table-wrap"><table><thead><tr>
      <th>When</th><th>Serial</th><th>Type</th><th>Status</th><th>Problem</th><th>By</th><th></th>
    </tr></thead><tbody>${data.map(r => {
      const canEdit = isAdmin || r.created_by === window.currentProfile.id;
      const pill = r.record_type === "Red Tag" ? "pill-danger" : "pill-warn";
      const statusPill = r.status === "Open" ? "pill-warn"
        : r.status === "Repaired" || r.status === "Closed" ? "pill-success" : "pill-info";
      return `<tr>
        <td>${escapeHtml(fmtDateTime(r.recorded_at))}</td>
        <td><strong>${escapeHtml(r.serial_number)}</strong></td>
        <td><span class="pill ${pill}">${escapeHtml(r.record_type)}</span></td>
        <td><span class="pill ${statusPill}">${escapeHtml(r.status)}</span></td>
        <td>${escapeHtml((r.problem_description || "").slice(0, 50))}${(r.problem_description || "").length > 50 ? "…" : ""}</td>
        <td>${escapeHtml(r.profiles?.display_name || "—")}</td>
        <td>
          ${canEdit ? `<button class="btn btn-outline btn-sm" data-edit="${r.id}">Edit</button>` : ""}
          ${canEdit ? `<button class="btn btn-outline btn-sm" data-archive="${r.id}">Archive</button>` : ""}
        </td>
      </tr>`;
    }).join("")}</tbody></table></div>`;

    el.querySelectorAll("[data-edit]").forEach(b => {
      b.addEventListener("click", () => {
        const rec = data.find(x => x.id === b.dataset.edit);
        editRecord(rec);
      });
    });
    el.querySelectorAll("[data-archive]").forEach(b => {
      b.addEventListener("click", () => {
        window.Utils.confirmDialog("Archive this quality record?", async () => {
          const { error: e2 } = await window.db.from("quality_records")
            .update({ archived_at: new Date().toISOString(), archived_by: window.currentProfile.id })
            .eq("id", b.dataset.archive);
          if (e2) { toast(e2.message, "error"); return; }
          toast("Archived", "success");
          loadTable();
        }, "Archive");
      });
    });
  }

  function editRecord(rec) {
    const statuses = ["Open", "In Progress", "Repaired", "Scrapped", "Closed"];
    openModal({
      title: `Edit — ${rec.serial_number}`,
      bodyHtml: `
        <div class="form-group"><label>Status</label>
          <select class="select" name="status">
            ${statuses.map(s => `<option ${s === rec.status ? "selected" : ""}>${s}</option>`).join("")}
          </select></div>
        <div class="form-group"><label>Repair action</label>
          <textarea class="textarea" name="repair_action">${escapeHtml(rec.repair_action || "")}</textarea></div>
        <div class="form-group"><label>Responsible person</label>
          <input class="input" name="responsible_person" value="${escapeHtml(rec.responsible_person || "")}" /></div>
      `,
      saveLabel: "Save changes",
      onSave: async (fd, close) => {
        const { error } = await window.db.from("quality_records").update({
          status: fd.status,
          repair_action: fd.repair_action || null,
          responsible_person: fd.responsible_person || null
        }).eq("id", rec.id);
        if (error) { toast(error.message, "error"); return; }
        toast("Updated", "success");
        close();
        loadTable();
      }
    });
  }

  window.Router.register("#/quality", render, { title: "Quality — Red Tag / Rework" });
})();