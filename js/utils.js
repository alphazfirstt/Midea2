(function () {
  const DEFAULT_TZ = (window.MIDEA_CONFIG && window.MIDEA_CONFIG.TIMEZONE) || "Africa/Addis_Ababa";

  function isValidTZ(tz) {
    try { new Intl.DateTimeFormat("en-GB", { timeZone: tz }); return true; } catch { return false; }
  }

  // Honour the timezone saved in Settings (if valid), otherwise the configured default.
  function getTZ() {
    let saved = null;
    try { saved = localStorage.getItem("midea_factory_tz"); } catch {}
    return saved && isValidTZ(saved) ? saved : DEFAULT_TZ;
  }

  // Offset (e.g. "+03:00") of the factory timezone at a given instant.
  function tzOffsetString(date) {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: getTZ(), hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit"
    }).formatToParts(date).reduce((a, p) => (a[p.type] = p.value, a), {});
    const asUTC = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
    const diffMin = Math.round((asUTC - Math.floor(date.getTime() / 1000) * 1000) / 60000);
    const sign = diffMin < 0 ? "-" : "+";
    const abs = Math.abs(diffMin);
    return `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
  }

  // ISO timestamp (with offset) for 00:00 of a YYYY-MM-DD date in the factory timezone.
  // Use with .gte() for "from" and with .lt(dayStartISO(nextDay)) for an inclusive "to".
  function dayStartISO(ymd) {
    const guess = new Date(ymd + "T12:00:00Z");
    return `${ymd}T00:00:00${tzOffsetString(guess)}`;
  }

  function addDaysYMD(ymd, n) {
    const d = new Date(ymd + "T12:00:00Z");
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }

  // Start of the day AFTER ymd — exclusive upper bound for an inclusive "to" date.
  function dayEndExclusiveISO(ymd) { return dayStartISO(addDaysYMD(ymd, 1)); }

  function escapeHtml(s) {
    if (s === null || s === undefined) return "";
    return String(s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function fmtDate(v) {
    if (!v) return "—";
    try {
      // Plain dates have no time/zone: format them as UTC so they never shift a day.
      if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)) {
        return new Date(v + "T12:00:00Z").toLocaleDateString("en-GB", { timeZone: "UTC", day: "2-digit", month: "short", year: "numeric" });
      }
      return new Date(v).toLocaleDateString("en-GB", { timeZone: getTZ(), day: "2-digit", month: "short", year: "numeric" });
    } catch { return String(v); }
  }

  function fmtTime(v) {
    if (!v) return "—";
    try {
      return new Date(v).toLocaleTimeString("en-GB", { timeZone: getTZ(), hour: "2-digit", minute: "2-digit", hour12: false });
    } catch { return String(v); }
  }

  function fmtDateTime(v) {
    if (!v) return "—";
    return `${fmtDate(v)} ${fmtTime(v)}`;
  }

  function todayISO() {
    return new Date().toLocaleDateString("en-CA", { timeZone: getTZ() }); // YYYY-MM-DD
  }

  function daysAgoISO(n) {
    return addDaysYMD(todayISO(), -n);
  }

  function toast(msg, type = "info", duration = 3200) {
    const c = document.getElementById("toast-container");
    if (!c) return;
    const el = document.createElement("div");
    el.className = "toast " + type;
    el.textContent = msg;
    c.appendChild(el);
    setTimeout(() => { el.style.opacity = "0"; el.style.transition = "opacity .2s"; }, Math.max(0, duration - 200));
    setTimeout(() => el.remove(), duration);
  }

  let loadingCount = 0;
  function showLoading(show = true) {
    loadingCount = show ? loadingCount + 1 : Math.max(0, loadingCount - 1);
    const el = document.getElementById("loading-overlay");
    if (!el) return;
    el.classList.toggle("hidden", loadingCount === 0);
  }

  function openModal({ title, bodyHtml, onSave, saveLabel = "Save", danger = false }) {
    const root = document.getElementById("modal-root");
    root.innerHTML = `
      <div class="modal-backdrop">
        <div class="modal" role="dialog" aria-modal="true">
          <div class="modal-head">
            <h3>${escapeHtml(title)}</h3>
            <button class="icon-btn" data-close>✕</button>
          </div>
          <form class="modal-form">
            <div class="modal-body">${bodyHtml}</div>
            <div class="modal-foot">
              <button type="button" class="btn btn-outline" data-close>Cancel</button>
              <button type="submit" class="btn ${danger ? "btn-danger" : "btn-primary"}">${escapeHtml(saveLabel)}</button>
            </div>
          </form>
        </div>
      </div>`;
    const close = () => { root.innerHTML = ""; };
    root.querySelectorAll("[data-close]").forEach(b => b.addEventListener("click", close));
    root.querySelector(".modal-backdrop").addEventListener("click", (e) => {
      if (e.target.classList.contains("modal-backdrop")) close();
    });
    root.querySelector(".modal-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const form = e.target;
      const submitBtn = form.querySelector('button[type="submit"]');
      if (submitBtn && submitBtn.disabled) return;
      if (submitBtn) submitBtn.disabled = true;
      const data = Object.fromEntries(new FormData(form).entries());
      try {
        await onSave(data, close);
      } catch (err) {
        toast(err.message || "Save failed", "error");
      } finally {
        if (submitBtn && submitBtn.isConnected) submitBtn.disabled = false;
      }
    });
  }

  function confirmDialog(message, onConfirm, confirmLabel = "Confirm") {
    openModal({
      title: "Please confirm",
      bodyHtml: `<p>${escapeHtml(message)}</p>`,
      saveLabel: confirmLabel,
      danger: true,
      onSave: async (_data, close) => { close(); await onConfirm(); }
    });
  }

  function csvEscape(v) {
    if (v === null || v === undefined) return "";
    let s = String(v);
    // Neutralise spreadsheet formula injection in text cells (numbers are left alone).
    if (typeof v === "string" && /^[=+\-@\t\r]/.test(s) && isNaN(Number(s))) s = "'" + s;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  function downloadCSV(filename, rows) {
    const csv = "\uFEFF" + rows.map(r => r.map(csvEscape).join(",")).join("\r\n"); // BOM so Excel reads UTF-8
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function debounce(fn, ms = 300) {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  }

  function getFormData(formEl) {
    return Object.fromEntries(new FormData(formEl).entries());
  }

  window.Utils = {
    escapeHtml, fmtDate, fmtTime, fmtDateTime, todayISO, daysAgoISO,
    dayStartISO, dayEndExclusiveISO, addDaysYMD, isValidTZ, getTZ,
    toast, showLoading, openModal, confirmDialog, downloadCSV, debounce, getFormData,
    get TIMEZONE() { return getTZ(); }
  };
})();