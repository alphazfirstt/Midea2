(function () {
  const { escapeHtml, toast, showLoading, openModal } = window.Utils;

  async function render(container, profile) {
    if (profile.role !== "admin") {
      container.innerHTML = `<div class="empty">Access denied</div>`;
      return;
    }

    container.innerHTML = `
      <div class="card">
        <div class="card-title">⚙️ Factory settings</div>
        <div class="form-group"><label>Factory name</label>
          <input class="input" id="factory-name" />
          <div class="hint">Displayed in reports and headers</div>
        </div>
        <div class="form-group"><label>Timezone</label>
          <input class="input" id="factory-tz" value="Africa/Addis_Ababa" />
        </div>
        <div class="form-group"><label>Serial number format (regular expression, optional)</label>
          <input class="input" id="serial-pattern" placeholder="e.g. ^[A-Z0-9]{10,16}$" autocomplete="off" spellcheck="false" />
          <div class="hint">Typed, scanned and OCR serials that don't match are rejected, which stops misreads being saved.
            Stored on this device; set <code>SERIAL_PATTERN</code> in <code>js/config.js</code> to apply it everywhere.</div>
        </div>
        <button class="btn btn-primary" id="save-settings">Save settings</button>
      </div>

      <div class="card">
        <div class="card-title">📋 Models</div>
        <form id="model-form" style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px">
          <input class="input" name="name" placeholder="Model name" required style="flex:1;min-width:150px" />
          <input class="input" name="description" placeholder="Description" style="flex:2;min-width:150px" />
          <button class="btn btn-primary" type="submit">Add</button>
        </form>
        <div id="models-table"></div>
      </div>

      <div class="card">
        <div class="card-title">📦 Materials</div>
        <form id="material-form" style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px">
          <input class="input" name="name" placeholder="Material name" required style="flex:1;min-width:150px" />
          <input class="input" name="unit" placeholder="Unit (kg, pcs)" value="kg" style="width:100px" />
          <button class="btn btn-primary" type="submit">Add</button>
        </form>
        <div id="materials-table"></div>
      </div>

      <div class="card">
        <div class="card-title">💰 Opening balances</div>
        <div class="hint" style="margin-bottom:10px">Set the starting stock for each material (once per material).</div>
        <div id="opening-table"></div>
      </div>`;

    document.getElementById("factory-name").value = localStorage.getItem("midea_factory_name") || window.MIDEA_CONFIG.FACTORY_NAME || "Midea Refrigerator Factory — Ethiopia";
    document.getElementById("factory-tz").value = localStorage.getItem("midea_factory_tz") || window.MIDEA_CONFIG.TIMEZONE || "Africa/Addis_Ababa";

    document.getElementById("serial-pattern").value = localStorage.getItem("midea_serial_pattern") || "";

    document.getElementById("save-settings").addEventListener("click", () => {
      const pattern = document.getElementById("serial-pattern").value.trim();
      try { if (pattern) new RegExp(pattern); } catch (e) {
        toast("Serial format is not a valid regular expression.", "error", 5000);
        return;
      }
      const name = document.getElementById("factory-name").value.trim();
      const tz = document.getElementById("factory-tz").value.trim();
      // An invalid IANA zone used to be saved as-is and then broke every date shown in the app.
      if (tz && !window.Utils.isValidTZ(tz)) {
        toast("Unknown timezone. Use an IANA name such as Africa/Addis_Ababa.", "error", 5000);
        return;
      }
      try {
        localStorage.setItem("midea_factory_name", name);
        localStorage.setItem("midea_factory_tz", tz);
        localStorage.setItem("midea_serial_pattern", pattern);
      } catch (e) { toast("Could not save settings in this browser.", "error"); return; }
      toast("Settings saved", "success");
    });

    document.getElementById("model-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const fd = window.Utils.getFormData(e.target);
      showLoading(true);
      const { error } = await window.db.from("models").insert({
        name: fd.name.trim(),
        description: fd.description || null
      });
      showLoading(false);
      if (error) { toast(error.message, "error"); return; }
      toast("Model added", "success");
      e.target.reset();
      loadModels();
    });

    document.getElementById("material-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const fd = window.Utils.getFormData(e.target);
      showLoading(true);
      const { error } = await window.db.from("materials").insert({
        name: fd.name.trim(),
        unit: fd.unit || "kg"
      });
      showLoading(false);
      if (error) { toast(error.message, "error"); return; }
      toast("Material added", "success");
      e.target.reset();
      loadMaterials();
      loadOpening();
    });

    await Promise.all([loadModels(), loadMaterials(), loadOpening()]);
  }

  async function loadModels() {
    const el = document.getElementById("models-table");
    const { data } = await window.db.from("models").select("*").order("name");
    if (!data?.length) { el.innerHTML = `<div class="empty">No models</div>`; return; }
    el.innerHTML = `<div class="table-wrap"><table><thead><tr>
      <th>Name</th><th>Description</th><th>Status</th><th></th>
    </tr></thead><tbody>${data.map(m => `<tr>
      <td><strong>${escapeHtml(m.name)}</strong></td>
      <td>${escapeHtml(m.description || "—")}</td>
      <td><span class="pill ${m.is_active ? "pill-success" : "pill-muted"}">${m.is_active ? "Active" : "Inactive"}</span></td>
      <td><button class="btn btn-outline btn-sm" data-toggle-model="${m.id}" data-active="${m.is_active}">${m.is_active ? "Deactivate" : "Activate"}</button></td>
    </tr>`).join("")}</tbody></table></div>`;
    el.querySelectorAll("[data-toggle-model]").forEach(b => {
      b.addEventListener("click", async () => {
        const active = b.dataset.active === "true";
        const { error } = await window.db.from("models").update({ is_active: !active }).eq("id", b.dataset.toggleModel);
        if (error) { toast(error.message, "error"); return; }
        loadModels();
      });
    });
  }

  async function loadMaterials() {
    const el = document.getElementById("materials-table");
    const { data } = await window.db.from("materials").select("*").order("name");
    if (!data?.length) { el.innerHTML = `<div class="empty">No materials</div>`; return; }
    el.innerHTML = `<div class="table-wrap"><table><thead><tr>
      <th>Name</th><th>Unit</th><th>Status</th><th></th>
    </tr></thead><tbody>${data.map(m => `<tr>
      <td><strong>${escapeHtml(m.name)}</strong></td>
      <td>${escapeHtml(m.unit)}</td>
      <td><span class="pill ${m.is_active ? "pill-success" : "pill-muted"}">${m.is_active ? "Active" : "Inactive"}</span></td>
      <td><button class="btn btn-outline btn-sm" data-toggle-mat="${m.id}" data-active="${m.is_active}">${m.is_active ? "Deactivate" : "Activate"}</button></td>
    </tr>`).join("")}</tbody></table></div>`;
    el.querySelectorAll("[data-toggle-mat]").forEach(b => {
      b.addEventListener("click", async () => {
        const active = b.dataset.active === "true";
        const { error } = await window.db.from("materials").update({ is_active: !active }).eq("id", b.dataset.toggleMat);
        if (error) { toast(error.message, "error"); return; }
        loadMaterials();
        loadOpening();
      });
    });
  }

  async function loadOpening() {
    const el = document.getElementById("opening-table");
    const [{ data: mats }, { data: obs }] = await Promise.all([
      window.db.from("materials").select("*").eq("is_active", true).order("name"),
      window.db.from("opening_balances").select("*")
    ]);
    if (!mats?.length) { el.innerHTML = `<div class="empty">No materials</div>`; return; }
    el.innerHTML = `<div class="table-wrap"><table><thead><tr>
      <th>Material</th><th>Opening balance</th><th>Effective date</th><th></th>
    </tr></thead><tbody>${mats.map(m => {
      const ob = (obs || []).find(o => o.material_id === m.id);
      return `<tr>
        <td><strong>${escapeHtml(m.name)}</strong></td>
        <td>${ob ? Number(ob.quantity).toFixed(2) : "—"}</td>
        <td>${ob ? escapeHtml(ob.effective_date) : "—"}</td>
        <td><button class="btn btn-outline btn-sm" data-set-ob="${m.id}" data-name="${escapeHtml(m.name)}">${ob ? "Update" : "Set"}</button></td>
      </tr>`;
    }).join("")}</tbody></table></div>`;
    el.querySelectorAll("[data-set-ob]").forEach(b => {
      b.addEventListener("click", () => {
        const existing = (obs || []).find(o => o.material_id === b.dataset.setOb) || null;
        setOpening(b.dataset.setOb, b.dataset.name, existing);
      });
    });
  }

  function setOpening(materialId, name, existing) {
    openModal({
      title: `Opening balance — ${name}`,
      bodyHtml: `
        <div class="form-group"><label>Quantity</label>
          <input class="input" type="number" step="0.001" min="0" name="quantity" value="${existing ? escapeHtml(existing.quantity) : ""}" required /></div>
        <div class="form-group"><label>Effective date</label>
          <input class="input" type="date" name="effective_date" value="${escapeHtml(existing ? existing.effective_date : window.Utils.todayISO())}" required /></div>`,
      saveLabel: "Save",
      onSave: async (fd, close) => {
        const qty = parseFloat(fd.quantity);
        if (!Number.isFinite(qty) || qty < 0) { toast("Enter a valid quantity.", "warning"); return; }
        const payload = { quantity: qty, effective_date: fd.effective_date };
        const { error } = existing
          ? await window.db.from("opening_balances").update(payload).eq("material_id", materialId)
          : await window.db.from("opening_balances").insert({ material_id: materialId, ...payload });
        if (error) { toast(error.message, "error"); return; }
        toast("Opening balance saved", "success");
        close();
        loadOpening();
      }
    });
  }

  window.Router.register("#/settings", render, { title: "Settings", roles: ["admin"] });
})();