(function () {
  const { escapeHtml, toast, todayISO, daysAgoISO, downloadCSV, dayStartISO, dayEndExclusiveISO } = window.Utils;
  let modelsCache = [];

  async function render(container) {
    const { data: models } = await window.db.from("models").select("*").eq("is_active", true).order("name");
    modelsCache = models || [];

    container.innerHTML = `
      <div class="card">
        <div class="card-title">📈 Reports</div>
        <div class="form-group"><label>Report type</label>
          <select class="select" id="rtype">
            <option value="production">Production</option>
            <option value="welding">Welding registrations</option>
            <option value="quality">Quality (Red Tag / Rework)</option>
            <option value="deliveries">Material deliveries</option>
            <option value="consumption">Material consumption</option>
            <option value="inventory">Current inventory</option>
            <option value="serial-history">Refrigerator serial history</option>
          </select></div>
        <div class="form-group"><label>From</label>
          <input class="input" type="date" id="r-from" value="${daysAgoISO(30)}" /></div>
        <div class="form-group"><label>To</label>
          <input class="input" type="date" id="r-to" value="${todayISO()}" /></div>
        <div class="form-group"><label>Model (optional)</label>
          <select class="select" id="r-model">
            <option value="">All models</option>
            ${modelsCache.map(m => `<option value="${m.id}">${escapeHtml(m.name)}</option>`).join("")}
          </select></div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn btn-primary" id="run-report">Run report</button>
          <button class="btn btn-outline" id="export-csv" disabled>⬇ Export CSV</button>
        </div>
      </div>

      <div class="card">
        <div class="card-title" id="report-title">Report results</div>
        <div id="report-output"><div class="empty">Choose a report and tap Run</div></div>
      </div>`;

    document.getElementById("run-report").addEventListener("click", runReport);
    document.getElementById("rtype").addEventListener("change", () => {
      document.getElementById("report-output").innerHTML = `<div class="empty">Tap Run report</div>`;
      document.getElementById("export-csv").disabled = true;
    });
    document.getElementById("export-csv").addEventListener("click", exportCurrent);
  }

  // Supabase/PostgREST returns at most 1000 rows per request, which silently truncated big
  // reports (and made the totals wrong). Page through the whole result instead.
  async function fetchAll(q) {
    const PAGE = 1000;
    let all = [];
    for (let offset = 0; ; offset += PAGE) {
      const { data, error } = await q.range(offset, offset + PAGE - 1);
      if (error) throw error;
      all = all.concat(data || []);
      if (!data || data.length < PAGE) break;
      if (offset > 200000) break; // safety stop
    }
    return all;
  }

  let currentRows = []; // for CSV
  let currentHeaders = [];

  async function runReport() {
    const type = document.getElementById("rtype").value;
    const from = document.getElementById("r-from").value;
    const to = document.getElementById("r-to").value;
    const modelId = document.getElementById("r-model").value;
    const out = document.getElementById("report-output");
    const title = document.getElementById("report-title");
    if (from && to && from > to) { toast("'From' date must not be after 'To' date.", "warning"); return; }
    out.innerHTML = `<div class="spinner" style="margin:0 auto"></div>`;
    document.getElementById("export-csv").disabled = true;

    try {
      let result;
      switch (type) {
        case "production":    result = await reportProduction(from, to, modelId); break;
        case "welding":       result = await reportWelding(from, to, modelId); break;
        case "quality":       result = await reportQuality(from, to, modelId); break;
        case "deliveries":    result = await reportDeliveries(from, to); break;
        case "consumption":   result = await reportConsumption(from, to, modelId); break;
        case "inventory":     result = await reportInventory(); break;
        case "serial-history":result = await reportSerialHistory(from, to, modelId); break;
      }
      title.textContent = result.title;
      currentHeaders = result.headers;
      currentRows = result.rows;

      if (!result.rows.length) {
        out.innerHTML = `<div class="empty">No data for this range</div>`;
        return;
      }

      const summaryHtml = result.summary
        ? `<div class="stats-grid" style="margin-bottom:14px">${result.summary.map(s => `
            <div class="stat accent"><div class="label">${escapeHtml(s.label)}</div>
            <div class="value">${escapeHtml(String(s.value))}</div>
            <div class="sub">${escapeHtml(s.sub || "")}</div></div>`).join("")}</div>`
        : "";

      out.innerHTML = summaryHtml + `<div class="table-wrap"><table><thead><tr>
        ${result.headers.map(h => `<th>${escapeHtml(h)}</th>`).join("")}
      </tr></thead><tbody>${result.rows.map(r => `<tr>
        ${r.map(c => `<td>${escapeHtml(c == null ? "" : String(c))}</td>`).join("")}
      </tr>`).join("")}</tbody></table></div>`;

      document.getElementById("export-csv").disabled = false;
    } catch (e) {
      out.innerHTML = `<div class="empty">Error: ${escapeHtml(e.message)}</div>`;
    }
  }

  function exportCurrent() {
    if (!currentRows.length) return;
    const name = `midea-report-${document.getElementById("rtype").value}-${todayISO()}.csv`;
    downloadCSV(name, [currentHeaders, ...currentRows]);
    toast("CSV downloaded", "success");
  }

  async function reportProduction(from, to, modelId) {
    let q = window.db.from("production_records")
      .select("id,production_date,quantity,shift,models(name),profiles:created_by(display_name)")
      .is("archived_at", null).order("production_date", { ascending: false }).order("id");
    if (from) q = q.gte("production_date", from);
    if (to) q = q.lte("production_date", to);
    if (modelId) q = q.eq("model_id", modelId);
    const data = await fetchAll(q);
    const total = (data || []).reduce((s, r) => s + (Number(r.quantity) || 0), 0);
    return {
      title: "Production report",
      summary: [{ label: "Total units", value: total, sub: "in range" }],
      headers: ["Date", "Model", "Quantity", "Shift", "By"],
      rows: (data || []).map(r => [r.production_date, r.models?.name || "", r.quantity, r.shift || "", r.profiles?.display_name || ""])
    };
  }

  async function reportWelding(from, to, modelId) {
    let q = window.db.from("fridge_weld_records")
      .select("id,serial_number,welded_at,models(name),profiles:created_by(display_name)")
      .is("archived_at", null).order("welded_at", { ascending: false }).order("id");
    if (from) q = q.gte("welded_at", dayStartISO(from));
    if (to) q = q.lt("welded_at", dayEndExclusiveISO(to));
    if (modelId) q = q.eq("model_id", modelId);
    const data = await fetchAll(q);
    return {
      title: "Welding report",
      summary: [{ label: "Total welds", value: (data || []).length, sub: "in range" }],
      headers: ["Serial", "Model", "Welded at", "By"],
      rows: (data || []).map(r => [r.serial_number, r.models?.name || "", fmtDateTimeShort(r.welded_at), r.profiles?.display_name || ""])
    };
  }

  async function reportQuality(from, to, modelId) {
    let q = window.db.from("quality_records")
      .select("id,serial_number,record_type,status,problem_description,recorded_at,models(name),profiles:created_by(display_name)")
      .is("archived_at", null).order("recorded_at", { ascending: false }).order("id");
    if (from) q = q.gte("recorded_at", dayStartISO(from));
    if (to) q = q.lt("recorded_at", dayEndExclusiveISO(to));
    if (modelId) q = q.eq("model_id", modelId);
    const data = await fetchAll(q);
    const reds = (data || []).filter(r => r.record_type === "Red Tag").length;
    const reworks = (data || []).filter(r => r.record_type === "Rework").length;
    return {
      title: "Quality report",
      summary: [
        { label: "Red Tags", value: reds },
        { label: "Reworks", value: reworks }
      ],
      headers: ["When", "Serial", "Type", "Status", "Problem", "By"],
      rows: (data || []).map(r => [fmtDateTimeShort(r.recorded_at), r.serial_number, r.record_type, r.status, r.problem_description || "", r.profiles?.display_name || ""])
    };
  }

  async function reportDeliveries(from, to) {
    let q = window.db.from("material_deliveries")
      .select("id,delivery_date,quantity,supplier,reference_number,materials(name),profiles:created_by(display_name)")
      .is("archived_at", null).order("delivery_date", { ascending: false }).order("id");
    if (from) q = q.gte("delivery_date", from);
    if (to) q = q.lte("delivery_date", to);
    const data = await fetchAll(q);
    return {
      title: "Material deliveries",
      headers: ["Date", "Material", "Qty", "Supplier", "Reference", "By"],
      rows: (data || []).map(r => [r.delivery_date, r.materials?.name || "", r.quantity, r.supplier || "", r.reference_number || "", r.profiles?.display_name || ""])
    };
  }

  async function reportConsumption(from, to, modelId) {
    let q = window.db.from("material_consumption")
      .select("id,production_date,quantity,notes,materials(name),models(name),profiles:created_by(display_name)")
      .is("archived_at", null).order("production_date", { ascending: false }).order("id");
    if (from) q = q.gte("production_date", from);
    if (to) q = q.lte("production_date", to);
    if (modelId) q = q.eq("model_id", modelId);
    const data = await fetchAll(q);
    return {
      title: "Material consumption",
      headers: ["Date", "Material", "Qty", "Model", "Notes", "By"],
      rows: (data || []).map(r => [r.production_date, r.materials?.name || "", r.quantity, r.models?.name || "", r.notes || "", r.profiles?.display_name || ""])
    };
  }

  async function reportInventory() {
    const { data, error } = await window.db.from("material_stock").select("*");
    if (error) throw error;
    return {
      title: "Current inventory",
      headers: ["Material", "Opening", "Deliveries", "Consumption", "Current stock", "Unit"],
      rows: (data || []).map(r => [r.material_name, r.opening_balance, r.total_deliveries, r.total_consumption, r.current_stock, r.unit])
    };
  }

  async function reportSerialHistory(from, to, modelId) {
    let q = window.db.from("fridge_weld_records")
      .select("id,serial_number,welded_at,models(name),profiles:created_by(display_name)")
      .is("archived_at", null).order("welded_at", { ascending: false }).order("id");
    if (from) q = q.gte("welded_at", dayStartISO(from));
    if (to) q = q.lt("welded_at", dayEndExclusiveISO(to));
    if (modelId) q = q.eq("model_id", modelId);
    const data = await fetchAll(q);
    return {
      title: "Refrigerator serial history",
      summary: [{ label: "Registrations", value: (data || []).length, sub: "in range" }],
      headers: ["Serial", "Model", "Welded at", "By"],
      rows: (data || []).map(r => [r.serial_number, r.models?.name || "", fmtDateTimeShort(r.welded_at), r.profiles?.display_name || ""])
    };
  }

  function fmtDateTimeShort(v) {
    if (!v) return "";
    return window.Utils.fmtDateTime(v);
  }

  window.Router.register("#/reports", render, { title: "Reports" });
})();