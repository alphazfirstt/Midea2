(function () {
  const { escapeHtml, toast, fmtDateTime, dayStartISO } = window.Utils;
  const S = window.Scanner;

  const COOLDOWN_SAVED_MS = 8000;     // ignore a code that was just registered
  const COOLDOWN_FAILED_MS = 4000;    // ignore a code that was discarded / rejected
  const COOLDOWN_INVALID_MS = 3000;   // ignore a non-serial code (wrong format) while the camera is still on it

  let modelsCache = [];
  let selectedModelId = "";
  let scanner = null;
  let pending = null;                 // serial waiting for the operator's confirmation (scanner is paused)
  let sessionCount = 0;
  const handledSerials = new Set();   // serials registered (or found to exist) during this visit
  let registering = false;            // blocks double-submits
  let ocrBusy = false;
  let audioCtx = null;

  const $ = (id) => document.getElementById(id);

  function getAutoRegister() { try { return localStorage.getItem("midea_auto_register") === "1"; } catch (e) { return false; } }
  function setAutoRegister(v) { try { localStorage.setItem("midea_auto_register", v ? "1" : "0"); } catch (e) {} }

  async function render(container, profile) {
    try {
      // The page is rebuilt on every visit, so remembered state must be reset too; otherwise welds
      // were registered against a model the user couldn't see.
      if (scanner) { await scanner.stop("leave"); scanner = null; }
      selectedModelId = ""; sessionCount = 0; pending = null; handledSerials.clear();
      container.innerHTML = `<div class="empty"><div class="spinner" style="margin:0 auto"></div></div>`;

      const { data: models, error } = await window.db
        .from("models").select("*").eq("is_active", true).order("name");
      if (error) throw error;
      modelsCache = models || [];

      container.innerHTML = `
        <div class="card">
          <div class="card-title">🔧 Welding Registration</div>

          <div class="form-group">
            <label>Refrigerator model (stays selected)</label>
            <select class="select" id="welding-model">
              <option value="">— Select a model —</option>
              ${modelsCache.map(m => `<option value="${m.id}">${escapeHtml(m.name)}</option>`).join("")}
            </select>
          </div>

          <div class="form-group" style="background:#F9FAFB;border:1px solid var(--line-strong);padding:14px;border-radius:8px;margin-top:6px">
            <label style="font-size:14px;font-weight:600;color:var(--text)">Serial Number</label>
            <div style="display:flex;gap:8px;margin-top:6px">
              <input class="input" id="inline-serial" placeholder="Type, scan, or use camera…" style="flex:1;font-size:16px;letter-spacing:.5px" autocomplete="off" autocapitalize="characters" spellcheck="false" />
              <button class="btn btn-primary" id="inline-register-btn" type="button" style="white-space:nowrap">Register</button>
            </div>
            <div class="hint" style="margin-top:6px">💡 Press <b>Enter</b> after typing/scanner</div>
          </div>

          <details style="margin-top:12px" open>
            <summary style="cursor:pointer;font-size:14px;color:var(--text-muted);padding:6px 0;font-weight:600">📷 Camera Reader (Barcode, QR &amp; Text)</summary>
            <div class="scanner-box off" id="scanner-box" style="margin-top:10px">
              <video id="scanner-video" playsinline muted autoplay></video>
              <div class="scanner-overlay"></div>
              <div class="scanner-hint" id="scanner-hint">Camera off</div>
            </div>
            <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px">
              <button id="start-scan-btn" class="btn btn-secondary" type="button">Start camera</button>
              <button id="torch-btn" class="btn btn-outline" type="button" disabled>🔦 Light</button>
              <button id="capture-btn" class="btn btn-outline" type="button" disabled>Scan now</button>
              <button id="ocr-btn" class="btn btn-primary" type="button" disabled>📸 Read Text (OCR)</button>
              <button id="stop-scan-btn" class="btn btn-outline" type="button" disabled>Stop</button>
            </div>
            <label style="display:flex;gap:8px;align-items:center;margin-top:12px;font-size:14px;cursor:pointer">
              <input type="checkbox" id="auto-register" ${getAutoRegister() ? "checked" : ""} />
              Auto-register scans (skip confirmation — only if the label format is validated)
            </label>
            <div class="hint" style="margin-top:6px">A code is accepted after it is read twice in a row. By default you confirm it before it is saved.
              OCR takes 2–5 seconds — point closely at the numbers.</div>
          </details>

          <div class="scan-result" id="scan-result">Enter a serial or use the camera above.</div>
          <div style="margin-top:8px;color:#6B7280;font-size:13px">
            Welds registered this session: <strong id="session-count">0</strong>
          </div>
        </div>

        <div class="card">
          <div class="card-title">Recent welds</div>
          <div class="toolbar">
            <input class="input" id="search-weld" placeholder="Search serial…" />
            <input class="input" id="search-from" type="date" />
            <select class="select" id="search-model">
              <option value="">All models</option>
              ${modelsCache.map(m => `<option value="${m.id}">${escapeHtml(m.name)}</option>`).join("")}
            </select>
            <div class="spacer"></div>
            <button class="btn btn-outline btn-sm" id="refresh-welds" type="button">Refresh</button>
          </div>
          <div id="welds-table"></div>
        </div>`;

      $("welding-model").addEventListener("change", (e) => {
        selectedModelId = e.target.value;
        if (selectedModelId) toast("Model locked in — ready to enter serials.", "success");
      });

      $("inline-register-btn").addEventListener("click", submitSerial);
      $("inline-serial").addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); submitSerial(); }
      });
      $("auto-register").addEventListener("change", (e) => setAutoRegister(e.target.checked));

      $("start-scan-btn").addEventListener("click", startScanner);
      $("stop-scan-btn").addEventListener("click", () => stopScanner("user"));
      $("torch-btn").addEventListener("click", toggleTorch);
      $("capture-btn").addEventListener("click", scanNow);
      $("ocr-btn").addEventListener("click", captureAndReadText);

      $("refresh-welds").addEventListener("click", loadWelds);
      $("search-weld").addEventListener("input", window.Utils.debounce(loadWelds, 300));
      $("search-from").addEventListener("change", loadWelds);
      $("search-model").addEventListener("change", loadWelds);

      await loadWelds();
    } catch (e) {
      console.error("Welding render error:", e);
      container.innerHTML = `<div class="empty">
        <div class="big">⚠️</div>
        <p>Failed to load welding page.</p>
        <p style="font-size:13px;color:#999">${escapeHtml(e.message || String(e))}</p>
      </div>`;
    }
  }

  /* ---------------- result panel ---------------- */

  function showResult(kind, title, body, extraHtml) {
    const box = $("scan-result");
    if (!box) return;
    box.className = "scan-result" + (kind ? " " + kind : "");
    box.innerHTML = `<strong>${escapeHtml(title)}</strong>${body ? escapeHtml(body) : ""}${extraHtml || ""}`;
  }

  function showPending(serial, source, alternatives) {
    const alts = (alternatives || []).filter(a => a !== serial).slice(0, 4);
    const altHtml = alts.length
      ? `<div class="cand-row"><span>Other text found:</span>${alts.map(a => `<button type="button" class="cand-chip" data-alt="${escapeHtml(a)}">${escapeHtml(a)}</button>`).join("")}</div>`
      : "";
    showResult("pending", `${source === "ocr" ? "📸 Text read" : "📷 Scanned"}: ${serial}`,
      "Check it matches the label, then press Register (Enter). Wrong? Discard it.",
      `<div class="cand-row"><button type="button" class="btn btn-outline btn-sm" id="discard-btn">Discard</button></div>${altHtml}`);
    const d = $("discard-btn"); if (d) d.addEventListener("click", discardPending);
    document.querySelectorAll("[data-alt]").forEach(b => b.addEventListener("click", () => {
      $("inline-serial").value = b.dataset.alt; $("inline-serial").focus();
    }));
  }

  /* ---------------- scanner glue ---------------- */

  function setButtons(running) {
    const set = (id, disabled) => { const el = $(id); if (el) el.disabled = disabled; };
    set("start-scan-btn", running);
    set("stop-scan-btn", !running);
    set("capture-btn", !running);
    set("ocr-btn", !running);
    set("torch-btn", !running || !(scanner && scanner.hasTorch()));
    const t = $("torch-btn"); if (t && !running) t.textContent = "🔦 Light";
  }

  function setHint(text) { const h = $("scanner-hint"); if (h) h.textContent = text; }

  function onScannerState(state) {
    const box = $("scanner-box");
    if (box) box.className = "scanner-box " + state;
    if (state === "scanning") setHint("Point at the label — hold steady");
    else if (state === "paused") setHint("Code captured — confirm below");
    else setHint("Camera off");
  }

  function onScannerStop(reason) {
    pending = null;
    setButtons(false);
    const msg = {
      hidden: "Camera turned off because the tab was hidden. Tap Start camera to continue.",
      idle: "Camera turned off after 5 minutes without a scan. Tap Start camera to continue.",
      ended: "The camera was disconnected. Tap Start camera to try again.",
      error: ""
    }[reason];
    if (msg) { setHint(msg); toast(msg, "warning", 5000); }
  }

  async function startScanner() {
    if (scanner && scanner.isRunning()) return;
    const video = $("scanner-video");
    if (!video) return;
    setHint("Starting camera…");
    $("start-scan-btn").disabled = true;
    scanner = S.create({
      video,
      onCode: handleCode,
      onState: onScannerState,
      onStop: onScannerStop,
      onError: (e) => toast(S.describeError(e), "error", 6000)
    });
    try {
      await scanner.start();
      setButtons(true);
      const eng = scanner.getEngine() === "native" ? "native" : "ZXing";
      setHint(`Point at the label — hold steady (${eng} reader)`);
    } catch (e) {
      console.error("Scanner error:", e);
      toast(S.describeError(e), "error", 7000);
      setButtons(false);
      setHint("Camera off");
      scanner = null;
    }
  }

  async function stopScanner(reason) {
    if (scanner) { const s = scanner; await s.stop(reason || "user"); }
    pending = null;
    setButtons(false);
  }

  async function toggleTorch() {
    if (!scanner || !scanner.hasTorch()) return;
    const ok = await scanner.setTorch(!scanner.isTorchOn());
    const b = $("torch-btn");
    if (!ok) { toast("This camera's light cannot be controlled.", "warning"); return; }
    if (b) b.textContent = scanner.isTorchOn() ? "🔦 Light on" : "🔦 Light";
  }

  async function scanNow() {
    if (!scanner || !scanner.isRunning()) return;
    if (scanner.isPaused()) { toast("Confirm or discard the current code first.", "warning"); return; }
    const btn = $("capture-btn"); btn.disabled = true;
    try {
      const text = await scanner.decodeFrame();
      if (text) scanner.accept(text);
      else toast("No readable code in this frame. Move closer, hold steady, or use the light.", "warning");
    } finally { if (scanner && scanner.isRunning()) btn.disabled = false; }
  }

  // A code was read (twice in a row) or captured manually. The scanner is paused until resume().
  function handleCode(serial) {
    try { navigator.vibrate && navigator.vibrate(60); } catch (e) {}

    const inputEl = $("inline-serial");
    if (inputEl && document.activeElement === inputEl && inputEl.value.trim() && pending === null) {
      // The operator is typing: never overwrite their text with a camera read.
      toast("Finish or clear the typed serial first — scan ignored.", "warning");
      scanner.ignore(serial, COOLDOWN_INVALID_MS); scanner.resume();
      return;
    }
    const v = S.validateSerial(serial);
    if (!v.ok) {
      showResult("error", "⚠ Ignored code", `"${serial.slice(0, 40)}" — ${v.reason}`);
      scanner.ignore(serial, COOLDOWN_INVALID_MS); scanner.resume();
      return;
    }
    if (handledSerials.has(serial)) {
      showResult("pending", `Already registered: ${serial}`, "This serial was already handled during this visit — ignored.");
      scanner.ignore(serial, COOLDOWN_SAVED_MS); scanner.resume();
      return;
    }
    pending = serial;
    $("inline-serial").value = serial;
    if (getAutoRegister() && selectedModelId) { submitSerial(); return; }
    showPending(serial, "scan");
    if (!selectedModelId) {
      toast("Select a refrigerator model, then press Register.", "warning");
      $("welding-model").focus();
    } else {
      $("inline-serial").focus();
    }
  }

  function discardPending() {
    const serial = pending || S.normalizeSerial($("inline-serial").value);
    $("inline-serial").value = "";
    showResult("", "Discarded", "Scanning continues.");
    pending = null;
    if (scanner && scanner.isRunning()) { scanner.ignore(serial, COOLDOWN_FAILED_MS); scanner.resume(); }
  }

  // After a registration attempt: resume scanning, ignoring this code for a while.
  // "hold" (e.g. no model chosen yet) keeps the captured code waiting for the operator.
  function finishAttempt(serial, outcome) {
    if (outcome === "hold" || outcome === "busy") return;
    if (pending !== null && scanner && scanner.isRunning()) {
      scanner.ignore(pending, outcome === "saved" ? COOLDOWN_SAVED_MS : COOLDOWN_FAILED_MS);
      scanner.ignore(serial, outcome === "saved" ? COOLDOWN_SAVED_MS : COOLDOWN_FAILED_MS);
      scanner.resume();
    }
    pending = null;
  }

  /* ---------------- OCR ---------------- */

  // Turn raw OCR output into candidate serials. The old code glued ALL lines together, which mixed
  // the serial with every other word on the label. Now each line is a separate candidate.
  function ocrCandidates(text) {
    const seen = new Set();
    const out = [];
    String(text || "").split(/\r?\n/).forEach(line => {
      const c = S.normalizeSerial(line).replace(/[^A-Z0-9]/g, "");
      if (c.length >= 6 && !seen.has(c)) { seen.add(c); out.push(c); }
    });
    // Prefer lines that look like a valid serial, then longer ones.
    out.sort((a, b) => (S.validateSerial(b).ok - S.validateSerial(a).ok) || (b.length - a.length));
    return out;
  }

  async function captureAndReadText() {
    if (ocrBusy) return;
    if (!scanner || !scanner.isRunning()) { toast("Start the camera first.", "warning"); return; }
    const videoEl = $("scanner-video");
    if (!videoEl || !videoEl.videoWidth) { toast("Camera not ready.", "warning"); return; }
    if (scanner.isPaused()) { toast("Confirm or discard the current code first.", "warning"); return; }

    ocrBusy = true;
    $("ocr-btn").disabled = true;
    scanner.pause();
    showResult("", "⏳ Reading text…", "Please wait (2–5 seconds)");

    let worker = null, found = false;
    try {
      const T = await S.ensureTesseract();
      const canvas = scanner.frameCanvas();
      worker = await T.createWorker("eng");
      await worker.setParameters({ tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 -" });
      const { data: { text } } = await worker.recognize(canvas);
      const cands = ocrCandidates(text);
      if (cands.length) {
        found = true;
        pending = cands[0];
        $("inline-serial").value = cands[0];
        showPending(cands[0], "ocr", cands);
        $("inline-serial").focus();
      } else {
        showResult("error", "⚠ No text detected", "Move closer to the numbers and make sure there is good light.");
      }
    } catch (e) {
      console.error("OCR error", e);
      showResult("error", "OCR failed", S.describeError(e).replace(/^Camera error: /, ""));
    } finally {
      // Always free the OCR worker (it was leaked whenever recognition threw).
      if (worker) { try { await worker.terminate(); } catch (e) {} }
      ocrBusy = false;
      if (scanner && scanner.isRunning()) {
        $("ocr-btn").disabled = false;
        if (!found) scanner.resume();      // keep scanning unless a result is waiting for confirmation
      }
    }
  }

  /* ---------------- registration ---------------- */

  async function submitSerial() {
    const input = $("inline-serial");
    const serial = S.normalizeSerial(input.value);
    if (!serial) { toast("Enter a serial number first.", "warning"); return; }
    const outcome = await registerWeld(serial);
    if (outcome === "saved") input.value = "";
    input.focus();
    finishAttempt(serial, outcome);
  }

  // Returns "saved" | "failed" | "hold" (needs operator action, keep the code) | "busy".
  async function registerWeld(serial) {
    const v = S.validateSerial(serial);
    if (!v.ok) { showResult("error", "⚠ Not registered", `${serial.slice(0, 40)} — ${v.reason}`); beep(false); return "failed"; }
    if (!selectedModelId) { toast("Select a model first.", "warning"); const m = $("welding-model"); if (m) m.focus(); return "hold"; }
    if (registering) return "busy";
    registering = true;
    try {
      const { error } = await window.db.from("fridge_weld_records").insert({
        serial_number: serial,
        model_id: selectedModelId,
        welded_at: new Date().toISOString()
      });
      if (error) throw error;
      handledSerials.add(serial);
      sessionCount++;
      const sessionEl = $("session-count");
      if (sessionEl) sessionEl.textContent = sessionCount;
      const model = modelsCache.find(m => m.id === selectedModelId);
      showResult("success", `✓ ${serial}`, `Registered for ${model?.name || ""}`);
      beep(true);
      loadWelds();
      return "saved";
    } catch (err) {
      const msg = String(err.message || err);
      if (err.code === "23505" || msg.toLowerCase().includes("duplicate") || msg.toLowerCase().includes("unique")) {
        handledSerials.add(serial);
        showResult("error", "⚠ Duplicate", `Serial ${serial} has already been welded.`);
      } else {
        showResult("error", "Error", msg);
      }
      beep(false);
      return "failed";
    } finally {
      registering = false;
    }
  }

  /* ---------------- recent welds table ---------------- */

  async function loadWelds() {
    const tableEl = $("welds-table");
    if (!tableEl) return;
    const search = ($("search-weld")?.value || "").trim();
    const fromDate = $("search-from")?.value || "";
    const modelFilter = $("search-model")?.value || "";

    let q = window.db.from("fridge_weld_records")
      .select("id,serial_number,welded_at,models(name),profiles:created_by(display_name)")
      .is("archived_at", null)
      .order("welded_at", { ascending: false })
      .limit(100);
    if (search) q = q.ilike("serial_number", `%${search}%`);
    if (fromDate) q = q.gte("welded_at", dayStartISO(fromDate));
    if (modelFilter) q = q.eq("model_id", modelFilter);

    const { data, error } = await q;
    if (!$("welds-table")) return;
    if (error) { tableEl.innerHTML = `<div class="empty">Error: ${escapeHtml(error.message)}</div>`; return; }
    if (!data.length) { tableEl.innerHTML = `<div class="empty">No welds found</div>`; return; }
    tableEl.innerHTML = `<div class="table-wrap"><table><thead><tr>
      <th>Serial</th><th>Model</th><th>By</th><th>When</th>
    </tr></thead><tbody>${data.map(r => `<tr>
      <td><strong>${escapeHtml(r.serial_number)}</strong></td>
      <td>${escapeHtml(r.models?.name || "—")}</td>
      <td>${escapeHtml(r.profiles?.display_name || "—")}</td>
      <td>${escapeHtml(fmtDateTime(r.welded_at))}</td>
    </tr>`).join("")}</tbody></table></div>`;
  }

  function beep(ok) {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      if (!audioCtx) audioCtx = new AC();          // one shared context (browsers cap how many may exist)
      if (audioCtx.state === "suspended") audioCtx.resume();
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.frequency.value = ok ? 880 : 320;
      o.connect(g); g.connect(audioCtx.destination);
      g.gain.setValueAtTime(0.08, audioCtx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.18);
      o.start(); o.stop(audioCtx.currentTime + 0.2);
    } catch (e) {}
  }

  window.Router.register("#/welding", render, {
    title: "Welding Registration",
    cleanup: async () => { await stopScanner("leave"); scanner = null; }
  });
})();
