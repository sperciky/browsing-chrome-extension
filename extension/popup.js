// popup.js
// Manages the popup UI: connects to background via long-lived port,
// handles button clicks, and renders live progress.

(function () {
  "use strict";

  // ─── DOM refs ──────────────────────────────────────────────────────────
  const downloadBtn   = document.getElementById("downloadBtn");
  const btnSpinner    = document.getElementById("btnSpinner");
  const btnText       = document.getElementById("btnText");
  const statusSection = document.getElementById("statusSection");
  const pagesValue    = document.getElementById("pagesValue");
  const scrollValue   = document.getElementById("scrollValue");
  const progressBar   = document.getElementById("progressBar");
  const phaseMsg      = document.getElementById("phaseMsg");
  const folderInfo    = document.getElementById("folderInfo");
  const errorBox      = document.getElementById("errorBox");
  const successBox    = document.getElementById("successBox");

  // ─── Connect to background ──────────────────────────────────────────────
  const port = chrome.runtime.connect({ name: "popup" });

  port.onMessage.addListener((msg) => {
    if (msg.type === "STATE") {
      renderState(msg.state);
    }
  });

  port.onDisconnect.addListener(() => {
    // Background service worker went to sleep – that's normal
  });

  // ─── Button click ───────────────────────────────────────────────────────
  downloadBtn.addEventListener("click", () => {
    port.postMessage({ type: "START" });
  });

  // ─── State renderer ─────────────────────────────────────────────────────

  const PHASE_LABELS = {
    idle:       "Ready to download",
    starting:   "Initialising...",
    title:      "Reading document title...",
    translated: "Title translated",
    scrolling:  "Scrolling to load all pages...",
    loading:    "Waiting for images to load...",
    building:   "Building PDF...",
    saving:     "Saving file...",
    done:       "Download complete!",
    error:      "Error",
  };

  function renderState(state) {
    const { running, phase, loaded, total, scrollPercent,
            folderName, filename, pageCount, error } = state;

    // ── Button state ──────────────────────────────────────────────────────
    if (running) {
      downloadBtn.disabled = true;
      btnSpinner.style.display = "block";
      btnText.textContent = "Downloading...";
    } else {
      downloadBtn.disabled = false;
      btnSpinner.style.display = "none";
      btnText.textContent = phase === "done" ? "Download Again" : "Download PDF";
    }

    // ── Status section ────────────────────────────────────────────────────
    if (phase !== "idle") {
      statusSection.style.display = "block";
    }

    // Pages counter
    const totalDisplay = typeof total === "number" ? total : total;
    pagesValue.textContent = `${loaded || 0} / ${totalDisplay || "?"}`;

    // Scroll progress
    scrollValue.textContent = `${scrollPercent || 0}%`;

    // Progress bar
    let pct = 0;
    if (phase === "scrolling") {
      pct = Math.min(40, ((scrollPercent || 0) * 0.4));
    } else if (phase === "loading") {
      pct = 40 + (total > 0 ? (loaded / total) * 20 : 0);
    } else if (phase === "building") {
      pct = 60 + (total > 0 ? (loaded / total) * 35 : 0);
    } else if (phase === "saving" || phase === "done") {
      pct = 100;
    }
    progressBar.style.width = `${Math.round(pct)}%`;

    // Phase message
    phaseMsg.textContent = PHASE_LABELS[phase] || phase;

    // ── Folder info ───────────────────────────────────────────────────────
    if (folderName && filename) {
      folderInfo.style.display = "block";
      folderInfo.innerHTML = `Saving to: <code>output/${folderName}/${filename}</code>`;
    } else {
      folderInfo.style.display = "none";
    }

    // ── Error box ─────────────────────────────────────────────────────────
    if (phase === "error" && error) {
      errorBox.style.display = "block";
      errorBox.textContent = error;
      successBox.style.display = "none";
    } else {
      errorBox.style.display = "none";
    }

    // ── Success box ───────────────────────────────────────────────────────
    if (phase === "done") {
      successBox.style.display = "block";
      successBox.textContent = `Done! ${pageCount || loaded} page${(pageCount || loaded) !== 1 ? "s" : ""} saved as "${filename}".`;
      errorBox.style.display = "none";
    } else {
      successBox.style.display = "none";
    }
  }

})();
