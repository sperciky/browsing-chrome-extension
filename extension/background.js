// background.js  (Manifest V3 – ES module service worker)
// Receives image URL list from content.js, fetches each image,
// builds PDF with pdf-lib, and triggers chrome.downloads.

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

// ─── Helpers ──────────────────────────────────────────────────────────────

// URL.createObjectURL is not available in MV3 service workers.
// Convert bytes to a base64 data URI that chrome.downloads.download accepts.
function uint8ArrayToDataUrl(bytes, mimeType = "application/pdf") {
  let binary = "";
  const CHUNK = 32768; // avoid stack overflow on spread
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(bytes.length, i + CHUNK)));
  }
  return `data:${mimeType};base64,${btoa(binary)}`;
}

function isJpeg(b) { return b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF; }
function isPng(b)  { return b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47; }

async function fetchImageBytes(url) {
  const r = await fetch(url, { credentials: "include" });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return new Uint8Array(await r.arrayBuffer());
}

// Proxy an image fetch through the content script so it runs with the tab's
// full cookie context (avoids SameSite / CDN CORS issues in the SW).
function fetchViaContentScript(tabId, frameId, url) {
  return new Promise((resolve, reject) => {
    const opts = frameId != null ? { frameId } : {};
    chrome.tabs.sendMessage(tabId, { type: "FETCH_IMAGE", url }, opts, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!response?.ok) {
        reject(new Error(response?.error || "Content script fetch failed"));
        return;
      }
      const binaryStr = atob(response.imageData);
      const bytes = new Uint8Array(binaryStr.length);
      for (let b = 0; b < binaryStr.length; b++) bytes[b] = binaryStr.charCodeAt(b);
      resolve(bytes);
    });
  });
}

// ─── PDF Builder ──────────────────────────────────────────────────────────

// context = { tabId, frameId } – used to proxy fetches through the content script
async function buildPDF(pages, context, onProgress) {
  const pdfDoc = await PDFDocument.create();

  for (let i = 0; i < pages.length; i++) {
    const { url, width, height } = pages[i];
    if (onProgress) onProgress(i + 1, pages.length);

    let bytes;
    try {
      // Primary: fetch via content script (has full tab cookie context, handles WebP→JPEG)
      bytes = await fetchViaContentScript(context.tabId, context.frameId, url);
    } catch (_) {
      // Fallback: direct fetch from service worker
      try {
        bytes = await fetchImageBytes(url);
      } catch (e) {
        console.warn(`[bg] skip page ${i + 1}: ${e.message}`);
        pdfDoc.addPage([A4_W, A4_H]);
        continue;
      }
    }

    let embeddedImage;
    try {
      embeddedImage = isJpeg(bytes) ? await pdfDoc.embedJpg(bytes)
                    : isPng(bytes)  ? await pdfDoc.embedPng(bytes)
                    : await pdfDoc.embedJpg(bytes);
    } catch (e) {
      // Try the other format as fallback
      try {
        embeddedImage = isPng(bytes) ? await pdfDoc.embedJpg(bytes) : await pdfDoc.embedPng(bytes);
      } catch (_) {
        console.warn(`[bg] embed failed page ${i + 1}: ${e.message}`);
        pdfDoc.addPage([A4_W, A4_H]);
        continue;
      }
    }

    const imgAspect = embeddedImage.width / embeddedImage.height;
    const a4Aspect  = A4_W / A4_H;
    let drawW, drawH;
    if (imgAspect > a4Aspect) { drawW = A4_W; drawH = A4_W / imgAspect; }
    else                      { drawH = A4_H; drawW = A4_H * imgAspect; }

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
  // Inject content scripts into all frames (idempotent – duplicate injection is caught)
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ["translator.js", "content.js"],
    });
  } catch (_) { /* already injected or page not scriptable */ }

  // Short pause so the injected scripts can register their listeners
  await new Promise(r => setTimeout(r, 150));

  // Enumerate all frames and find the viewer frame (docviewer.yandex.ru)
  const frames = await chrome.webNavigation.getAllFrames({ tabId }).catch(() => []);

  // Sort: prefer frames whose URL contains "docviewer" or "view"
  const sorted = (frames || []).sort((a, b) => {
    const aScore = (a.url || "").includes("docviewer") ? 1 : 0;
    const bScore = (b.url || "").includes("docviewer") ? 1 : 0;
    return bScore - aScore;
  });

  for (const frame of sorted) {
    try {
      const resp = await chrome.tabs.sendMessage(
        tabId,
        { type: "START_DOWNLOAD" },
        { frameId: frame.frameId }
      );
      if (resp && resp.accepted) return; // viewer found and accepted
    } catch (_) {
      // Frame not ready or no content script – try next
    }
  }

  // No frame accepted – show a helpful error
  setError(
    "Could not find the Yandex Document Viewer on this page. " +
    "Make sure you are on a docs.yandex.ru or docviewer.yandex.ru page " +
    "with a document open, then refresh and try again."
  );
}

// ─── Message router ───────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.type) {

    case "GET_STATE":
      sendResponse(state);
      return true;

    case "PROGRESS": {
      const { phase, loaded, total, scrollPercent, rawTitle, folderName, filename } = msg;
      if (phase)             state.phase        = phase;
      if (loaded  != null)   state.loaded       = loaded;
      if (total   != null)   state.total        = total;
      if (scrollPercent != null) state.scrollPercent = scrollPercent;
      if (rawTitle)   state.rawTitle   = rawTitle;
      if (folderName) state.folderName = folderName;
      if (filename)   state.filename   = filename;
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
      const { pages, folderName, filename } = msg;
      const context = { tabId: sender.tab?.id, frameId: sender.frameId };

      state.phase      = "building";
      state.loaded     = 0;
      state.total      = pages.length;
      state.folderName = folderName;
      state.filename   = filename;
      broadcastState();

      buildPDF(pages, context, (current, total) => {
        state.loaded = current;
        state.total  = total;
        broadcastState();
      })
      .then(pdfBytes => {
        state.phase = "saving";
        broadcastState();

        const dataUrl = uint8ArrayToDataUrl(pdfBytes);

        chrome.downloads.download({
          url: dataUrl,
          filename: `${folderName}/${filename}`,
          saveAs: false,
          conflictAction: "uniquify",
        }, () => {
          if (chrome.runtime.lastError) {
            setError(chrome.runtime.lastError.message);
          } else {
            state.running   = false;
            state.phase     = "done";
            state.pageCount = pages.length;
            broadcastState();
          }
        });
      })
      .catch(err => setError(err.message || String(err)));

      sendResponse({ ok: true });
      return true;
    }

    case "DONE":
      state.running   = false;
      state.phase     = "done";
      state.pageCount = msg.pageCount || state.pageCount;
      broadcastState();
      sendResponse({ ok: true });
      return true;
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
      state.phase   = "starting";
      broadcastState();

      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab) { setError("No active tab found."); return; }

      await startDownload(tab.id);
    }
    if (msg.type === "RESET") {
      resetState();
      broadcastState();
    }
  });
});
