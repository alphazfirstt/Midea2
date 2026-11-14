/*
 * Camera barcode / serial scanner engine.
 *
 * - Engines: the browser's native BarcodeDetector when it is good enough (fast, no download),
 *   otherwise ZXing (loaded lazily, with a fallback CDN). If the native engine keeps failing at
 *   run time the scanner switches to ZXing by itself.
 * - Safety: a code must be read twice in a row before it is accepted (kills one-off misreads),
 *   the scanner pauses while a code is being confirmed, and recently handled codes are ignored
 *   for a cooldown so a camera pointed at the same label does not re-trigger.
 * - Battery/privacy: the camera is switched off when the tab is hidden, after a period of
 *   inactivity, when the page is left, or when the browser/OS ends the stream.
 */
(function () {
  const FORMATS_ZXING = [
    "CODE_128", "CODE_39", "CODE_93", "CODABAR", "EAN_13", "EAN_8",
    "UPC_A", "UPC_E", "ITF", "QR_CODE", "DATA_MATRIX", "PDF_417", "AZTEC"
  ];
  const FORMATS_NATIVE = [
    "code_128", "code_39", "code_93", "codabar", "ean_13", "ean_8",
    "upc_a", "upc_e", "itf", "qr_code", "data_matrix", "pdf417", "aztec"
  ];
  // Native engine is used only if it can read at least these (otherwise ZXing is the safer choice).
  const NATIVE_REQUIRED = ["code_128", "qr_code"];

  const ZXING_URLS = [
    "https://unpkg.com/@zxing/library@0.21.3/umd/index.min.js",
    "https://cdn.jsdelivr.net/npm/@zxing/library@0.21.3/umd/index.min.js"
  ];
  const TESSERACT_URLS = [
    "https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js",
    "https://unpkg.com/tesseract.js@5/dist/tesseract.min.js"
  ];

  const MAX_SERIAL_LENGTH = 64;

  /* ---------------- serial helpers ---------------- */

  // Trim, drop whitespace + control characters (scanners/GS1 codes can add them), upper-case.
  function normalizeSerial(v) {
    return String(v == null ? "" : v).replace(/[\u0000-\u001f\u007f\s]+/g, "").toUpperCase();
  }

  function getSerialPattern() {
    let src = "";
    try { src = localStorage.getItem("midea_serial_pattern") || ""; } catch (e) {}
    if (!src) src = (window.MIDEA_CONFIG && window.MIDEA_CONFIG.SERIAL_PATTERN) || "";
    src = String(src).trim();
    if (!src) return null;
    try { return new RegExp(src); } catch (e) { return null; } // an invalid pattern must never block work
  }

  function validateSerial(serial) {
    if (!serial) return { ok: false, reason: "Empty serial." };
    if (serial.length > MAX_SERIAL_LENGTH) return { ok: false, reason: `Too long to be a serial (${serial.length} characters).` };
    const re = getSerialPattern();
    if (re && !re.test(serial)) return { ok: false, reason: "Does not match the factory serial format." };
    return { ok: true };
  }

  /* ---------------- lazy library loading with fallback CDN ---------------- */

  const loading = {};
  function loadScript(urls, timeoutMs = 15000) {
    const key = urls.join("|");
    if (loading[key]) return loading[key];
    loading[key] = (async () => {
      let lastErr = null;
      for (const url of urls) {
        try {
          await new Promise((resolve, reject) => {
            const s = document.createElement("script");
            const t = setTimeout(() => { s.remove(); reject(new Error("timeout loading " + url)); }, timeoutMs);
            s.src = url; s.async = true;
            s.onload = () => { clearTimeout(t); resolve(); };
            s.onerror = () => { clearTimeout(t); s.remove(); reject(new Error("failed to load " + url)); };
            document.head.appendChild(s);
          });
          return;
        } catch (e) { lastErr = e; }
      }
      throw lastErr || new Error("could not load script");
    })();
    // Allow a retry later if every source failed (e.g. network was down).
    loading[key].catch(() => { delete loading[key]; });
    return loading[key];
  }

  async function ensureZXing() {
    if (window.ZXing) return window.ZXing;
    try { await loadScript(ZXING_URLS); } catch (e) {
      const err = new Error("The barcode library could not be downloaded. Check the internet connection, or type the serial manually.");
      err.code = "LIB_ZXING"; throw err;
    }
    if (!window.ZXing) { const err = new Error("Barcode library failed to initialise."); err.code = "LIB_ZXING"; throw err; }
    return window.ZXing;
  }

  async function ensureTesseract() {
    if (window.Tesseract) return window.Tesseract;
    try { await loadScript(TESSERACT_URLS); } catch (e) {
      const err = new Error("The text reader (OCR) could not be downloaded. Check the internet connection, or type the serial manually.");
      err.code = "LIB_TESS"; throw err;
    }
    if (!window.Tesseract) { const err = new Error("Text reader failed to initialise."); err.code = "LIB_TESS"; throw err; }
    return window.Tesseract;
  }

  /* ---------------- friendly camera errors ---------------- */

  function describeError(e) {
    const name = e && e.name;
    if (e && e.code === "INSECURE") return "The camera only works on a secure (https) page.";
    if (e && e.code === "NO_API") return "This browser cannot access the camera. Use a current Chrome, Edge, Safari or Firefox.";
    if (e && (e.code === "LIB_ZXING" || e.code === "LIB_TESS")) return e.message;
    if (name === "NotAllowedError" || name === "SecurityError") return "Camera permission was denied. Allow camera access for this site in the browser settings, then tap Start camera again.";
    if (name === "NotFoundError" || name === "OverconstrainedError") return "No camera was found on this device.";
    if (name === "NotReadableError" || name === "AbortError") return "The camera is busy (used by another app or tab). Close it and try again.";
    return "Camera error: " + ((e && e.message) || String(e));
  }

  /* ---------------- the scanner ---------------- */

  function createScanner(opts) {
    const o = Object.assign({
      video: null,
      needed: 2,              // consecutive identical reads required
      windowMs: 1500,         // max gap between those reads
      idleMs: 5 * 60 * 1000,  // auto-off when nothing accepted for this long
      intervalMs: 120,        // native engine polling interval
      onCode: () => {},       // (serial) - scanner is paused until resume()
      onError: null,          // (error) - runtime failure after start (e.g. library could not load)
      onStop: () => {},       // (reason)  - "user" | "leave" | "hidden" | "idle" | "ended" | "error"
      onState: () => {}       // ("off" | "scanning" | "paused")
    }, opts || {});
    const video = o.video;

    let stream = null, track = null;
    let running = false, starting = false, paused = false;
    let engine = null;             // "native" | "zxing"
    let detector = null, zxReader = null, pollTimer = null, idleTimer = null;
    let busy = false, nativeErrors = 0, torchOn = false, torchOK = false;
    let cand = { text: "", n: 0, at: 0 };
    const ignored = new Map();

    function setState() { o.onState(!running ? "off" : paused ? "paused" : "scanning"); }

    function bumpIdle() {
      clearTimeout(idleTimer);
      if (!running || !o.idleMs) return;
      idleTimer = setTimeout(() => { stop("idle"); }, o.idleMs);
    }

    /* ----- accepting reads ----- */

    function isIgnored(text, now) {
      const until = ignored.get(text);
      if (until && now < until) return true;
      if (until) ignored.delete(text);
      return false;
    }

    // Feed one raw read from an engine. Returns true when it was accepted.
    function feed(raw) {
      if (!running || paused) return false;
      const text = normalizeSerial(raw);
      if (!text) return false;
      const now = Date.now();
      if (isIgnored(text, now)) return false;
      if (cand.text === text && now - cand.at <= o.windowMs) cand.n++;
      else cand = { text, n: 1, at: now };
      cand.at = now;
      if (cand.n >= o.needed) { accept(text); return true; }
      return false;
    }

    // Accept a code immediately (used by the manual "scan now" button, which is deliberate).
    function accept(text) {
      const t = normalizeSerial(text);
      if (!t || !running) return;
      cand = { text: "", n: 0, at: 0 };
      paused = true; setState(); bumpIdle();
      o.onCode(t);
    }

    function ignore(text, ms) {
      const t = normalizeSerial(text);
      if (!t) return;
      const now = Date.now();
      ignored.set(t, now + ms);
      for (const [k, v] of ignored) if (v < now) ignored.delete(k);
    }

    function pause() { if (!running) return; paused = true; setState(); }
    function resume() {
      if (!running) return;
      cand = { text: "", n: 0, at: 0 };
      paused = false; setState(); bumpIdle();
    }

    // With several barcodes in view prefer one that looks like a serial.
    function pickBest(values) {
      const list = values.map(normalizeSerial).filter(Boolean);
      return list.find(v => validateSerial(v).ok) || list[0] || "";
    }

    /* ----- engines ----- */

    async function chooseEngine() {
      if (typeof window.BarcodeDetector === "function") {
        try {
          const supported = await window.BarcodeDetector.getSupportedFormats();
          if (NATIVE_REQUIRED.every(f => supported.includes(f))) {
            detector = new window.BarcodeDetector({ formats: FORMATS_NATIVE.filter(f => supported.includes(f)) });
            return "native";
          }
        } catch (e) { /* fall through to ZXing */ }
      }
      await ensureZXing();
      return "zxing";
    }

    function zxHints() {
      const Z = window.ZXing;
      const hints = new Map();
      hints.set(Z.DecodeHintType.POSSIBLE_FORMATS, FORMATS_ZXING.map(n => Z.BarcodeFormat[n]).filter(x => x !== undefined));
      hints.set(Z.DecodeHintType.TRY_HARDER, true);
      return hints;
    }

    function startZXingLoop() {
      zxReader = new window.ZXing.BrowserMultiFormatReader(zxHints(), 200);
      zxReader.decodeFromStream(stream, video, (result) => {
        if (result && typeof result.getText === "function") feed(result.getText());
      });
    }

    function startNativeLoop() {
      pollTimer = setInterval(async () => {
        if (busy || paused || !running || !video.videoWidth) return;
        busy = true;
        try {
          const found = await detector.detect(video);
          nativeErrors = 0;
          if (found && found.length) {
            const best = pickBest(found.map(f => f.rawValue));
            if (best) feed(best);
          }
        } catch (e) {
          nativeErrors++;
          if (nativeErrors >= 5) await switchToZXing();
        } finally { busy = false; }
      }, o.intervalMs);
    }

    async function switchToZXing() {
      clearInterval(pollTimer); pollTimer = null;
      try {
        await ensureZXing();
        engine = "zxing";
        if (running) startZXingLoop();
      } catch (e) { if (o.onError) o.onError(e); stop("error"); }
    }

    /* ----- lifecycle ----- */

    function onVisibility() { if (document.hidden) stop("hidden"); }

    async function start() {
      if (running || starting) return;
      if (!window.isSecureContext) { const e = new Error("insecure"); e.code = "INSECURE"; throw e; }
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { const e = new Error("no api"); e.code = "NO_API"; throw e; }
      starting = true;
      try {
        engine = await chooseEngine();               // may download ZXing; fails before the camera is touched
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } },
          audio: false
        });
        video.srcObject = stream;
        try { await video.play(); } catch (e) { /* autoplay quirks: the attributes on <video> cover it */ }

        track = stream.getVideoTracks ? stream.getVideoTracks()[0] : null;
        const caps = track && track.getCapabilities ? track.getCapabilities() : {};
        torchOK = !!caps.torch;
        if (caps.focusMode && caps.focusMode.includes("continuous") && track.applyConstraints) {
          track.applyConstraints({ advanced: [{ focusMode: "continuous" }] }).catch(() => {});
        }
        if (track) track.onended = () => stop("ended");

        running = true; paused = false; nativeErrors = 0; cand = { text: "", n: 0, at: 0 };
        document.addEventListener("visibilitychange", onVisibility);
        setState(); bumpIdle();
        if (engine === "native") startNativeLoop(); else startZXingLoop();
      } catch (e) {
        await teardown();
        throw e;
      } finally { starting = false; }
    }

    async function teardown() {
      clearInterval(pollTimer); pollTimer = null;
      clearTimeout(idleTimer); idleTimer = null;
      document.removeEventListener("visibilitychange", onVisibility);
      if (zxReader) { try { await zxReader.reset(); } catch (e) {} zxReader = null; }
      if (track) track.onended = null;
      if (stream) { try { stream.getTracks().forEach(t => t.stop()); } catch (e) {} stream = null; }
      track = null; torchOn = false; torchOK = false;
      if (video) { try { video.srcObject = null; } catch (e) {} }
    }

    async function stop(reason) {
      if (!running && !stream) return;
      const was = running;
      running = false; paused = false;
      await teardown();
      setState();
      if (was) o.onStop(reason || "user");
    }

    /* ----- torch + still capture ----- */

    async function setTorch(on) {
      if (!track || !torchOK) return false;
      try { await track.applyConstraints({ advanced: [{ torch: !!on }] }); torchOn = !!on; return true; }
      catch (e) { return false; }
    }

    function frameCanvas() {
      const c = document.createElement("canvas");
      c.width = video.videoWidth; c.height = video.videoHeight;
      c.getContext("2d").drawImage(video, 0, 0, c.width, c.height);
      return c;
    }

    // One deliberate attempt on the current frame: native first, then ZXing (TRY_HARDER) as a second chance.
    async function decodeFrame() {
      if (!running || !video.videoWidth) return "";
      const canvas = frameCanvas();
      if (detector) {
        try {
          const found = await detector.detect(canvas);
          const best = pickBest((found || []).map(f => f.rawValue));
          if (best) return best;
        } catch (e) { /* try ZXing */ }
      }
      try {
        const Z = await ensureZXing();
        const reader = new Z.BrowserMultiFormatReader(zxHints());
        let res;
        if (typeof reader.decodeFromCanvas === "function") res = reader.decodeFromCanvas(canvas);
        else res = reader.decodeBitmap(new Z.BinaryBitmap(new Z.HybridBinarizer(new Z.HTMLCanvasElementLuminanceSource(canvas))));
        return res && res.getText ? normalizeSerial(res.getText()) : "";
      } catch (e) { return ""; }       // NotFoundException = nothing readable in this frame
    }

    return {
      start, stop, pause, resume, ignore, feed, accept, setTorch, decodeFrame, frameCanvas,
      isRunning: () => running,
      isPaused: () => paused,
      getEngine: () => engine,
      hasTorch: () => torchOK,
      isTorchOn: () => torchOn
    };
  }

  window.Scanner = {
    create: createScanner,
    normalizeSerial, validateSerial, getSerialPattern,
    loadScript, ensureZXing, ensureTesseract, describeError,
    FORMATS_ZXING, FORMATS_NATIVE, MAX_SERIAL_LENGTH
  };
})();
