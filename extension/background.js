// background.js  (Manifest V3 – ES module service worker)
// Receives image URL list + metadata from content.js,
// fetches images, builds PDF using pdf-lib, and triggers chrome.downloads.

import { PDFDocument } from "./lib/pdf-lib.esm.min.js";

// ─── A4 constants ─────────────────────────────────────────────────────────
const A4_W = 595.28;
const A4_H = 841.89;

// ─── State ────────────────────────────────────────────────────────────────
let state = {
  running: false,
  phase: "idle",
  loaded: 0,
  total: 0,
  scrollPercent: 0,
  rawTitle: "",
  folderName: "",
  filename: "",
  pageCount: 0,
  error: null,
};

let popupPort = null;

function broadcastState() {
  if (popupPort) {
    try { popupPort.postMessage({ type: "STATE", state }); }
    catch (_) { popupPort = null; }
  }
}

function resetState() {
  state = { running: false, phase: "idle", loaded: 0, total: 0,
            scrollPercent: 0, rawTitle: "", folderName: "", filename: "",
            pageCount: 0, error: null };
}

function setError(msg) {
  state.running = false;
  state.phase = "error";
  state.error = msg;
  broadcastState();
}

// ─── Image helpers ────────────────────────────────────────────────────────

function isJpeg(bytes) {
  return bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF;
}

function isPng(bytes) {
  return bytes[0] === 0x89 && bytes[1] === 0x50 &&
         bytes[2] === 0x4E && bytes[3] === 0x47;
}

async function fetchImageBytes(url) {
  const response = await fetch(url, { credentials: "include" });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  const buffer = await response.arrayBuffer();
  return new Uint8Array(buffer);
}

// ─── PDF Builder ──────────────────────────────────────────────────────────

async function buildPDF(pages, onProgress) {
  const pdfDoc = await PDFDocument.create();

  for (let i = 0; i < pages.length; i++) {
    const { url, width, height } = pages[i];
    if (onProgress) onProgress(i + 1, pages.length);

    let bytes;
    try {
      bytes = await fetchImageBytes(url);
    } catch (e) {
      console.warn(`[bg] skip page ${i + 1}: ${e.message}`);
      pdfDoc.addPage([A4_W, A4_H]);
      continue;
    }

    let embeddedImage;
    try {
      if (isJpeg(bytes)) {
        embeddedImage = await pdfDoc.embedJpg(bytes);
      } else if (isPng(bytes)) {
        embeddedImage = await pdfDoc.embedPng(bytes);
      } else {
        // Try JPEG as fallback
        embeddedImage = await pdfDoc.embedJpg(bytes);
      }
    } catch (embedErr) {
      console.warn(`[bg] embed failed page ${i + 1}: ${embedErr.message}`);
      pdfDoc.addPage([A4_W, A4_H]);
      continue;
    }

    // Fit into A4, preserve aspect ratio
    const imgW = embeddedImage.width;
    const imgH = embeddedImage.height;
    const imgAspect = imgW / imgH;
    const a4Aspect = A4_W / A4_H;

    let drawW, drawH;
    if (imgAspect > a4Aspect) {
      drawW = A4_W;
      drawH = A4_W / imgAspect;
    } else {
      drawH = A4_H;
      drawW = A4_H * imgAspect;
    }

    const page = pdfDoc.addPage([A4_W, A4_H]);
    page.drawImage(embeddedImage, {
      x: (A4_W - drawW) / 2,
      y: (A4_H - drawH) / 2,
      width: drawW,
      height: drawH,
    });
  }

  return pdfDoc.save();
}

// ─── Start download flow ──────────────────────────────────────────────────

async function startDownload(tabId) {
  // Step 1: Inject scripts if needed
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ["translator.js", "content.js"],
    });
  } catch (_) { /* already injected */ }

  // Step 2: Find the right frame and start scanning
  const frames = await chrome.webNavigation.getAllFrames({ tabId }).catch(() => []);
  let accepted = false;

  const tryFrame = async (frameId) => {
    try {
      const resp = await chrome.tabs.sendMessage(
        tabId, { type: "START_DOWNLOAD" },
        frameId !== undefined ? { frameId } : {}
      );
      return resp && resp.accepted;
    } catch (_) { return false; }
  };

  for (const frame of (frames || [])) {
    if (await tryFrame(frame.frameId)) { accepted = true; break; }
  }

  if (!accepted) {
    if (await tryFrame(undefined)) {
      accepted = true;
    } else {
      setError("Could not reach the page. Please refresh and try again.");
    }
  }
}

// ─── Message router ───────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.type) {

    case "GET_STATE":
      sendResponse(state);
      return true;

    case "PROGRESS": {
      const { phase, loaded, total, scrollPercent, rawTitle, folderName, filename } = msg;
      if (phase)            state.phase        = phase;
      if (loaded  != null)  state.loaded       = loaded;
      if (total   != null)  state.total        = total;
      if (scrollPercent != null) state.scrollPercent = scrollPercent;
      if (rawTitle)  state.rawTitle  = rawTitle;
      if (folderName) state.folderName = folderName;
      if (filename)  state.filename  = filename;
      state.error = null;
      broadcastState();
      sendResponse({ ok: true });
      return true;
    }

    case "ERROR":
      setError(msg.message || "Unknown error");
      sendResponse({ ok: true });
      return true;

    case "BUILD_PDF": {
      // Content script collected all page image URLs; now background builds the PDF.
      const { pages, folderName, filename } = msg;

      state.phase = "building";
      state.loaded = 0;
      state.total = pages.length;
      state.folderName = folderName;
      state.filename = filename;
      broadcastState();

      buildPDF(pages, (current, total) => {
        state.loaded = current;
        state.total = total;
        broadcastState();
      }).then(async (pdfBytes) => {
        state.phase = "saving";
        broadcastState();

        // Create blob URL in extension context so chrome.downloads can access it
        const blob = new Blob([pdfBytes], { type: "application/pdf" });
        const blobUrl = URL.createObjectURL(blob);
        const downloadPath = `${folderName}/${filename}`;

        chrome.downloads.download({
          url: blobUrl,
          filename: downloadPath,
          saveAs: false,
          conflictAction: "uniquify",
        }, (downloadId) => {
          // Revoke after a minute
          setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);

          if (chrome.runtime.lastError) {
            setError(chrome.runtime.lastError.message);
          } else {
            state.running = false;
            state.phase = "done";
            state.pageCount = pages.length;
            broadcastState();
          }
        });

      }).catch(err => {
        setError(err.message || String(err));
      });

      sendResponse({ ok: true });
      return true;
    }

    case "DONE": {
      state.running = false;
      state.phase = "done";
      state.pageCount = msg.pageCount || state.pageCount;
      broadcastState();
      sendResponse({ ok: true });
      return true;
    }
  }
});

// ─── Popup port ───────────────────────────────────────────────────────────

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "popup") return;

  popupPort = port;
  port.postMessage({ type: "STATE", state });

  port.onDisconnect.addListener(() => { popupPort = null; });

  port.onMessage.addListener(async (msg) => {
    if (msg.type === "START") {
      if (state.running) { broadcastState(); return; }
      resetState();
      state.running = true;
      state.phase = "starting";
      broadcastState();

      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab) { setError("No active tab found"); return; }

      await startDownload(tab.id);
    }
    if (msg.type === "RESET") {
      resetState();
      broadcastState();
    }
  });
});
