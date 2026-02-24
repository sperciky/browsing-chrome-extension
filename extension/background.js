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

function isJpeg(b) { return b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF; }
function isPng(b)  { return b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47; }

/** Format a millisecond value as "123ms" or "1.23s" */
const ms = t => t < 1000 ? `${t.toFixed(0)}ms` : `${(t / 1000).toFixed(2)}s`;

// ─── IndexedDB helpers (shared with offscreen.js via the same origin) ─────

function openPdfIDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("pdf-downloader", 1);
    req.onupgradeneeded = e => e.target.result.createObjectStore("pdfs");
    req.onsuccess = e => resolve(e.target.result);
    req.onerror = e => reject(e.target.error);
  });
}

async function storePdfInIDB(bytes) {
  const db = await openPdfIDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("pdfs", "readwrite");
    tx.objectStore("pdfs").put(bytes, "pending");
    tx.oncomplete = resolve;
    tx.onerror = e => reject(e.target.error);
  });
}

// ─── Offscreen document trigger ───────────────────────────────────────────
// URL.createObjectURL is not available in MV3 service workers.
// The offscreen doc creates the blob: URL and returns it; the SW calls
// chrome.downloads.download() (which IS available in the SW).

async function triggerOffscreenDownload(filename) {
  const t0 = performance.now();
  const offscreenUrl = chrome.runtime.getURL("offscreen.html");
  const hasDoc = await chrome.offscreen.hasDocument().catch(() => false);
  if (!hasDoc) {
    const tCreate = performance.now();
    await chrome.offscreen.createDocument({
      url: offscreenUrl,
      reasons: ["BLOBS"],
      justification: "Create blob: URL for large PDF download — avoids data URI size limits",
    });
    console.log(`[timing log] offscreen createDocument: ${ms(performance.now() - tCreate)}`);
  } else {
    console.log(`[timing log] offscreen doc already existed — skipped createDocument`);
  }

  // Ask offscreen doc to read IDB bytes and produce a blob: URL
  const tBlob = performance.now();
  const resp = await new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: "PREPARE_BLOB" }, (r) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(r);
    });
  });
  console.log(`[timing log] PREPARE_BLOB roundtrip (IDB read + createObjectURL): ${ms(performance.now() - tBlob)}`);

  if (!resp?.ok) throw new Error(resp?.error || "Offscreen failed to create blob URL");

  const { blobUrl } = resp;
  console.log(`[bg] got blob URL from offscreen, triggering download: ${filename}`);

  // SW has access to chrome.downloads; offscreen does not
  const tDl = performance.now();
  return new Promise((resolve, reject) => {
    chrome.downloads.download(
      { url: blobUrl, filename, saveAs: false, conflictAction: "uniquify" },
      (downloadId) => {
        console.log(`[timing log] chrome.downloads.download() callback: ${ms(performance.now() - tDl)}`);
        console.log(`[timing log] triggerOffscreenDownload total: ${ms(performance.now() - t0)}`);
        // Tell offscreen to revoke the blob URL and close itself
        chrome.runtime.sendMessage({ type: "CLEANUP_OFFSCREEN", blobUrl });
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(downloadId);
      }
    );
  });
}

async function fetchImageBytes(url) {
  console.log(`[bg] direct fetch: ${url}`);
  const r = await fetch(url, { credentials: "include" });
  console.log(`[bg] direct fetch status: ${r.status} for ${url}`);
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return new Uint8Array(await r.arrayBuffer());
}

// Proxy an image fetch through the content script so it runs with the tab's
// full cookie context (avoids SameSite / CDN CORS issues in the SW).
function fetchViaContentScript(tabId, frameId, url) {
  return new Promise((resolve, reject) => {
    const opts = frameId != null ? { frameId } : {};
    console.log(`[bg] content-script fetch: tabId=${tabId} frameId=${frameId} url=${url}`);
    chrome.tabs.sendMessage(tabId, { type: "FETCH_IMAGE", url }, opts, (response) => {
      if (chrome.runtime.lastError) {
        console.warn(`[bg] content-script fetch error: ${chrome.runtime.lastError.message} url=${url}`);
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!response?.ok) {
        console.warn(`[bg] content-script fetch failed: ${response?.error} url=${url}`);
        reject(new Error(response?.error || "Content script fetch failed"));
        return;
      }
      const bytes = response.imageData ? response.imageData.length : 0;
      console.log(`[bg] content-script fetch ok: ${bytes} base64-chars url=${url}`);
      const binaryStr = atob(response.imageData);
      const arr = new Uint8Array(binaryStr.length);
      for (let b = 0; b < binaryStr.length; b++) arr[b] = binaryStr.charCodeAt(b);
      resolve(arr);
    });
  });
}

// ─── PDF Builder ──────────────────────────────────────────────────────────

// context = { tabId, frameId } – used to proxy fetches through the content script
async function buildPDF(pages, context, onProgress) {
  const t0 = performance.now();
  const pdfDoc = await PDFDocument.create();
  console.log(`[bg] buildPDF: ${pages.length} pages, tabId=${context.tabId}, frameId=${context.frameId}`);
  pages.forEach((p, i) => console.log(`[bg]   page ${i + 1}: ${p.url} (${p.width}×${p.height})`));

  // ── Phase 1: Parallel fetch ──────────────────────────────────────────────
  // Pages are independent — fetch up to CONCURRENCY at once.
  // Serial: 146 pages × ~550ms avg ≈ 80s.  Parallel ×4 ≈ 20s wall-clock.
  const CONCURRENCY = 4;
  const tFetchPhase = performance.now();
  const fetchedBytes = new Array(pages.length).fill(null);
  let fetchQueueIdx = 0;   // next page index to claim — safe in single-threaded JS
  let fetchedCount  = 0;   // for monotonic progress reporting
  let totalFetchMs  = 0;

  async function fetchWorker() {
    while (true) {
      const i = fetchQueueIdx++;
      if (i >= pages.length) return;
      const { url } = pages[i];
      const tFetch = performance.now();
      let bytes = null;
      try {
        bytes = await fetchViaContentScript(context.tabId, context.frameId, url);
        const fetchMs = performance.now() - tFetch;
        totalFetchMs += fetchMs;
        console.log(`[timing log] page ${i + 1} fetch (content-script): ${ms(fetchMs)} — ${bytes.length} bytes`);
      } catch (csErr) {
        console.warn(`[bg] page ${i + 1}: content-script fetch failed (${csErr.message}), trying direct fetch`);
        try {
          bytes = await fetchImageBytes(url);
          const fetchMs = performance.now() - tFetch;
          totalFetchMs += fetchMs;
          console.log(`[timing log] page ${i + 1} fetch (direct fallback): ${ms(fetchMs)} — ${bytes.length} bytes`);
        } catch (e) {
          console.warn(`[bg] page ${i + 1}: BOTH fetches failed (${ms(performance.now() - tFetch)}) — blank page. Error: ${e.message}`);
        }
      }
      fetchedBytes[i] = bytes;
      fetchedCount++;
      if (onProgress) onProgress(fetchedCount, pages.length);
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, fetchWorker));

  const fetchWallMs = performance.now() - tFetchPhase;
  console.log(`[timing log] fetch phase — wall-clock: ${ms(fetchWallMs)}, serial sum: ${ms(totalFetchMs)}, speedup: ${(totalFetchMs / fetchWallMs).toFixed(1)}×`);

  // ── Phase 2: Embed (serial — pdf-lib is not re-entrant) ──────────────────
  const tEmbedPhase = performance.now();
  let totalEmbedMs = 0;

  for (let i = 0; i < pages.length; i++) {
    const bytes = fetchedBytes[i];
    fetchedBytes[i] = null; // release reference so GC can reclaim while we embed later pages

    if (!bytes) {
      pdfDoc.addPage([A4_W, A4_H]);
      continue;
    }

    const fmt = isJpeg(bytes) ? "JPEG" : isPng(bytes) ? "PNG" : `UNKNOWN(0x${bytes[0].toString(16)}${bytes[1].toString(16)}${bytes[2].toString(16)}${bytes[3].toString(16)})`;
    console.log(`[bg] page ${i + 1}: format=${fmt} bytes=${bytes.length}`);

    const tEmbed = performance.now();
    let embeddedImage;
    try {
      embeddedImage = isJpeg(bytes) ? await pdfDoc.embedJpg(bytes)
                    : isPng(bytes)  ? await pdfDoc.embedPng(bytes)
                    : await pdfDoc.embedJpg(bytes);
      const embedMs = performance.now() - tEmbed;
      totalEmbedMs += embedMs;
      console.log(`[timing log] page ${i + 1} embed: ${ms(embedMs)}`);
    } catch (e) {
      console.warn(`[bg] page ${i + 1}: embed failed (${e.message}), trying alternate format`);
      try {
        embeddedImage = isPng(bytes) ? await pdfDoc.embedJpg(bytes) : await pdfDoc.embedPng(bytes);
        const embedMs = performance.now() - tEmbed;
        totalEmbedMs += embedMs;
        console.log(`[timing log] page ${i + 1} embed (alternate format): ${ms(embedMs)}`);
      } catch (e2) {
        console.warn(`[bg] page ${i + 1}: BOTH embed formats failed (${ms(performance.now() - tEmbed)}) — adding blank page. Error: ${e2.message}`);
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

  const avgFetch = pages.length > 0 ? totalFetchMs / pages.length : 0;
  const avgEmbed = pages.length > 0 ? totalEmbedMs / pages.length : 0;
  console.log(`[timing log] all ${pages.length} pages fetched  — total: ${ms(totalFetchMs)}, avg: ${ms(avgFetch)}/page`);
  console.log(`[timing log] all ${pages.length} pages embedded — total: ${ms(totalEmbedMs)}, avg: ${ms(avgEmbed)}/page`);

  const tSave = performance.now();
  const result = await pdfDoc.save();
  console.log(`[timing log] pdfDoc.save(): ${ms(performance.now() - tSave)} — output: ${result.length} bytes`);
  console.log(`[timing log] buildPDF total: ${ms(performance.now() - t0)}`);

  return result;
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

      const tBuildStart = performance.now();
      buildPDF(pages, context, (current, total) => {
        state.loaded = current;
        state.total  = total;
        broadcastState();
      })
      .then(async pdfBytes => {
        console.log(`[timing log] ── buildPDF phase: ${ms(performance.now() - tBuildStart)}`);
        state.phase = "saving";
        broadcastState();

        const tIDB = performance.now();
        await storePdfInIDB(pdfBytes);
        console.log(`[timing log] ── storePdfInIDB: ${ms(performance.now() - tIDB)} (${pdfBytes.length} bytes)`);

        const tOffscreen = performance.now();
        await triggerOffscreenDownload(`${folderName}/${filename}`);
        console.log(`[timing log] ── triggerOffscreenDownload: ${ms(performance.now() - tOffscreen)}`);

        console.log(`[timing log] ── TOTAL from BUILD_PDF to download started: ${ms(performance.now() - tBuildStart)}`);
        state.running   = false;
        state.phase     = "done";
        state.pageCount = pages.length;
        broadcastState();
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
