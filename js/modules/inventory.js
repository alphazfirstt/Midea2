(function () {
  const { escapeHtml, toast, fmtDate, todayISO, showLoading } = window.Utils;
  let materialsCache = [], modelsCache = [];

  async function render(container) {
    const [{ data: mats }, { data: mods }] = await Promise.all([
      window.db.from("materials").select("*").eq("is_active", true).order("name"),
      window.db.from("models").select("*").eq("is_active", true).order("name")
    ]);
    materialsCache = mats || [];
    modelsCache = mods || [];

    container.innerHTML = `
      <div class="card">
        <div class="card-title">📦 Current stock</div>
        <div id="stock-grid" class="stats-grid"></div>
      </div>

      <div class="card">
        <div class="card-title">Record material movement</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px">
          <button class="btn btn-primary" data-mode="delivery">+ Delivery</button>
          <button class="btn btn-secondary" data-mode="consumption">− Consumption</button>
        </div>
        <div id="movement-form"></div>
      </div>

      <div class="card">
        <div class="card-title">Movement history</div>
        <div class="toolbar">
          <select class="select" id="hist-type">
            <option value="all">All movements</option>
            <option value="delivery">Deliveries</option>
            <option value="consumption">Consumption</option>
          </select>
          <button class="btn btn-outline btn-sm" id="refresh-hist">Refresh</button>
        </div>
        <div id="history-table"></div>
      </div>`;

    document.querySelectorAll("[data-mode]").forEach(b => {
      b.addEventListener("click", () => renderMovementForm(b.dataset.mode));
    });
    document.getElementById("refresh-hist").addEventListener("click", loadHistory);
    document.getElementById("hist-type").addEventListener("change", loadHistory);

    await Promise.all([loadStock(), loadHistory()]);
    renderMovementForm("delivery");
  }

  function wireUnitLabel(form) {
    const sel = form.querySelector('[name="material_id"]');
    const lbl = form.querySelector("[data-unit-label]");
    const update = () => {
      const m = materialsCache.find(x => x.id === sel.value);
      lbl.textContent = m && m.unit ? `(${m.unit})` : "";
    };
    sel.addEventListener("change", update);
    update();
  }

  function positiveQty(raw) {
    const n = parseFloat(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  async function renderMovementForm(mode) {
    const el = document.getElementById("movement-form");
    if (mode === "delivery") {
      el.innerHTML = `<form id="deliv-form">
        <div class="form-group"><label>Material</label>
          <select class="select" name="material_id" required>
            <option value="">— Select —</option>
            ${materialsCache.map(m => `<option value="${m.id}">${escapeHtml(m.name)}</option>`).join("")}
          </select></div>
        <div class="form-group"><label>Quantity <span data-unit-label></span></label>
          <input class="input" type="number" step="0.001" min="0.001" name="quantity" required /></div>
        <div class="form-group"><label>Delivery date</label>
          <input class="input" type="date" name="delivery_date" value="${todayISO()}" required /></div>
        <div class="form-group"><label>Supplier</label>
          <input class="input" name="supplier" /></div>
        <div class="form-group"><label>Reference number</label>
          <input class="input" name="reference_number" /></div>
        <div class="form-group"><label>Notes</label>
          <textarea class="textarea" name="notes"></textarea></div>
        <button class="btn btn-primary" type="submit">Save delivery</button>
      </form>`;

      wireUnitLabel(el.querySelector("#deliv-form"));
      el.querySelector("#deliv-form").addEventListener("submit", async (e) => {
        e.preventDefault();
        const fd = window.Utils.getFormData(e.target);
        const qty = positiveQty(fd.quantity);
        if (qty === null) { toast("Quantity must be greater than 0.", "warning"); return; }
        showLoading(true);
        const { error } = await window.db.from("material_deliveries").insert({
          material_id: fd.material_id,
          quantity: qty,
          delivery_date: fd.delivery_date,
          supplier: fd.supplier || null,
          reference_number: fd.reference_number || null,
          notes: fd.notes || null
        });
        showLoading(false);
        if (error) { toast(error.message, "error"); return; }
        toast("Delivery saved", "success");
        e.target.reset();
        e.target.querySelector('[name="delivery_date"]').value = todayISO();
        wireUnitLabel(e.target);
        await Promise.all([loadStock(), loadHistory()]);
      });
    } else {
      el.innerHTML = `<form id="cons-form">
        <div class="form-group"><label>Material</label>
          <select class="select" name="material_id" required>
            <option value="">— Select —</option>
            ${materialsCache.map(m => `<option value="${m.id}">${escapeHtml(m.name)}</option>`).join("")}
          </select></div>
        <div class="form-group"><label>Quantity <span data-unit-label></span></label>
          <input class="input" type="number" step="0.001" min="0.001" name="quantity" required /></div>
        <div class="form-group"><label>Production date</label>
          <input class="input" type="date" name="production_date" value="${todayISO()}" required /></div>
        <div class="form-group"><label>Model (optional)</label>
          <select class="select" name="model_id">
            <option value="">—</option>
            ${modelsCache.map(m => `<option value="${m.id}">${escapeHtml(m.name)}</option>`).join("")}
          </select></div>
        <div class="form-group"><label>Notes</label>
          <textarea class="textarea" name="notes"></textarea></div>
        <button class="btn btn-primary" type="submit">Save consumption</button>
      </form>`;

      wireUnitLabel(el.querySelector("#cons-form"));
      el.querySelector("#cons-form").addEventListener("submit", async (e) => {
        e.preventDefault();
        const form = e.target;
        const fd = window.Utils.getFormData(form);
        const qty = positiveQty(fd.quantity);
        if (qty === null) { toast("Quantity must be greater than 0.", "warning"); return; }

        const save = async () => {
          showLoading(true);
          const { error } = await window.db.from("material_consumption").insert({
            material_id: fd.material_id,
            quantity: qty,
            production_date: fd.production_date,
            model_id: fd.model_id || null,
            notes: fd.notes || null
          });
          showLoading(false);
          if (error) { toast(error.message, "error"); return; }
          toast("Consumption saved", "success");
          form.reset();
          form.querySelector('[name="production_date"]').value = todayISO();
          wireUnitLabel(form);
          await Promise.all([loadStock(), loadHistory()]);
        };

        // Warn (don't silently allow) consumption larger than what is in stock.
        const mat = materialsCache.find(m => m.id === fd.material_id);
        const { data: st } = mat
          ? await window.db.from("material_stock")
              .select("current_stock,material_name,unit").eq("material_name", mat.name).maybeSingle()
          : { data: null };
        const available = st ? Number(st.current_stock) : null;
        if (available !== null && Number.isFinite(available) && qty > available) {
          window.Utils.confirmDialog(
            `Only ${available.toFixed(2)} ${st.unit || ""} of ${st.material_name} is in stock, but you are recording ${qty}. Record it anyway? Stock will go negative.`,
            save, "Record anyway");
          return;
        }
        await save();
      });
    }
  }

  async function loadStock() {
    const el = document.getElementById("stock-grid");
    const { data, error } = await window.db.from("material_stock").select("*");
    if (error) { el.innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`; return; }
    if (!data?.length) { el.innerHTML = `<div class="empty">No materials configured</div>`; return; }
    el.innerHTML = data.map(s => `
      <div class="stat accent">
        <div class="label">${escapeHtml(s.material_name)}</div>
        <div class="value">${Number(s.current_stock ?? 0).toFixed(2)} ${escapeHtml(s.unit || "")}</div>
        <div class="sub">Open ${Number(s.opening_balance).toFixed(2)} · In ${Number(s.total_deliveries).toFixed(2)} · Out ${Number(s.total_consumption).toFixed(2)}</div>
      </div>`).join("");
  }

  async function loadHistory() {
    const el = document.getElementById("history-table");
    const type = document.getElementById("hist-type").value;
    let rows = [];

    if (type === "all" || type === "delivery") {
      const { data } = await window.db.from("material_deliveries")
        .select("id,quantity,delivery_date,supplier,reference_number,created_at,materials(name),profiles:created_by(display_name)")
        .is("archived_at", null).order("delivery_date", { ascending: false }).limit(100);
      (data || []).forEach(r => rows.push({
        kind: "Delivery", when: r.delivery_date, material: r.materials?.name,
        qty: "+" + r.quantity, detail: r.supplier || r.reference_number || "",
        by: r.profiles?.display_name, created: r.created_at
      }));
    }
    if (type === "all" || type === "consumption") {
      const { data } = await window.db.from("material_consumption")
        .select("id,quantity,production_date,notes,created_at,materials(name),models(name),profiles:created_by(display_name)")
        .is("archived_at", null).order("production_date", { ascending: false }).limit(100);
      (data || []).forEach(r => rows.push({
        kind: "Consumption", when: r.production_date, material: r.materials?.name,
        qty: "−" + r.quantity, detail: r.models?.name || r.notes || "",
        by: r.profiles?.display_name, created: r.created_at
      }));
    }

    rows.sort((a, b) => new Date(b.created) - new Date(a.created));

    if (!rows.length) { el.innerHTML = `<div class="empty">No movements yet</div>`; return; }
    el.innerHTML = `<div class="table-wrap"><table><thead><tr>
      <th>Date</th><th>Type</th><th>Material</th><th>Qty</th><th>Detail</th><th>By</th>
    </tr></thead><tbody>${rows.map(r => `<tr>
      <td>${escapeHtml(fmtDate(r.when))}</td>
      <td><span class="pill ${r.kind === "Delivery" ? "pill-success" : "pill-warn"}">${escapeHtml(r.kind)}</span></td>
      <td>${escapeHtml(r.material || "—")}</td>
      <td><strong>${escapeHtml(r.qty)}</strong></td>
      <td>${escapeHtml(r.detail || "—")}</td>
      <td>${escapeHtml(r.by || "—")}</td>
    </tr>`).join("")}</tbody></table></div>`;
  }

  window.Router.register("#/inventory", render, { title: "Inventory" });
})();