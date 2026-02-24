// content.js
// Injected into the Yandex Document Viewer page (all frames).
// Scrolls to trigger lazy loading, collects page image URLs,
// then delegates PDF construction to the background service worker.

(function () {
  "use strict";

  if (window.__yandexPDFDownloaderActive) return;
  window.__yandexPDFDownloaderActive = true;

  // ─── Utilities ────────────────────────────────────────────────────────────

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  function sendProgress(data) {
    chrome.runtime.sendMessage({ type: "PROGRESS", ...data }).catch(() => {});
  }

  function sendError(msg) {
    chrome.runtime.sendMessage({ type: "ERROR", message: msg }).catch(() => {});
  }

  // ─── Viewer Frame Detection ───────────────────────────────────────────────
  // Returns true if this frame IS the actual Yandex document viewer.
  // We check hostname first (most reliable), then DOM elements.

  function isViewerFrame() {
    const host = location.hostname;
    // The viewer iframe always runs on docviewer.yandex.ru
    if (host === "docviewer.yandex.ru") return true;

    // Fallback DOM checks (for edge cases where viewer is same-origin)
    return !!(
      document.querySelector(".js-doc-page") ||
      document.querySelector("[data-index]") ||
      document.querySelector("[class*='orbHeadTitle']") ||
      document.querySelector("[class*='pages_']") ||
      document.querySelector(".html_Y5jrDemZ5zdvkEcuAzQc") ||
      document.querySelector(".js-doc-html") ||
      document.querySelector("img[src*='name=bg-']") ||
      document.querySelector("img[src*='htmlimage']")
    );
  }

  // Wait up to `maxMs` for the viewer DOM to appear.
  async function waitForViewerDOM(maxMs = 15000) {
    const interval = 300;
    let elapsed = 0;
    while (elapsed < maxMs) {
      if (
        document.querySelector("[class*='pages_']") ||
        document.querySelector(".html_Y5jrDemZ5zdvkEcuAzQc") ||
        document.querySelector(".js-doc-html") ||
        document.querySelector("[data-index]") ||
        document.querySelector("img[src*='name=bg-']") ||
        document.querySelector("img[src*='htmlimage']")
      ) {
        return true;
      }
      await sleep(interval);
      elapsed += interval;
    }
    return false;
  }

  // ─── Title Extraction ─────────────────────────────────────────────────────

  function extractDocumentTitle() {
    const selectors = [
      "[class*='orbHeadTitle']",
      "[class*='heading-sm'][class*='orbHead']",
      "[class*='docTitle']",
      "h1",
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) {
        const text = el.textContent.trim();
        if (text) return text;
      }
    }
    // Strip Yandex branding from <title>
    const t = document.querySelector("title");
    if (t) {
      return t.textContent
        .replace(/\s*[-–|]\s*Яндекс.*/i, "")
        .replace(/\s*[-–|]\s*Yandex.*/i, "")
        .trim();
    }
    return "document";
  }

  // ─── Title Translation ────────────────────────────────────────────────────

  function getFolderAndFilename(rawTitle) {
    if (window.YandexPDFTranslator) {
      const translated = window.YandexPDFTranslator.translateTitle(rawTitle);
      const folderName = window.YandexPDFTranslator.sanitizeFilename(translated);
      return { folderName, filename: folderName + ".pdf" };
    }
    const fallback = rawTitle.replace(/\.pdf$/i, "").trim() || "document";
    return { folderName: fallback, filename: fallback + ".pdf" };
  }

  // ─── Scroll Container ─────────────────────────────────────────────────────
  // The live viewer scrolls on .html_Y5jrDemZ5zdvkEcuAzQc (.js-doc-html).

  function findScrollable() {
    // Exact known selectors from Yandex Docs viewer (confirmed via saved HTML)
    const exactSelectors = [
      ".html_Y5jrDemZ5zdvkEcuAzQc",  // primary scroll container
      ".js-doc-html",                  // same element, stable class
      ".pages_mRGnD_fBeRK6yJ33usXQ",  // pages wrapper
      ".main_Ctw6fyhTXBLVKjW8bAPw",   // outer main area
      "[class*='html_']",              // hash-obfuscated fallback
      "[class*='main_']",
      "[class*='pages_']",
    ];
    for (const sel of exactSelectors) {
      const el = document.querySelector(sel);
      if (el && el.scrollHeight > el.clientHeight + 50) return el;
    }
    // Generic: deepest element with overflow scroll/auto
    const all = Array.from(document.querySelectorAll("*"));
    for (let i = all.length - 1; i >= 0; i--) {
      const el = all[i];
      const st = window.getComputedStyle(el);
      if ((st.overflowY === "scroll" || st.overflowY === "auto") &&
          el.scrollHeight > el.clientHeight + 100) {
        return el;
      }
    }
    return document.documentElement;
  }

  // ─── Total Page Detection ─────────────────────────────────────────────────

  function detectTotalPages() {
    const counter = document.querySelector("[class*='pageCounter']");
    if (counter) {
      const m = counter.textContent.match(/(\d+)\s*(?:из|of)\s*(\d+)/i);
      if (m) return parseInt(m[2], 10);
    }
    const input = document.querySelector("input[type='number'][min]");
    if (input && input.getAttribute("max")) {
      return parseInt(input.getAttribute("max"), 10);
    }
    const pages = document.querySelectorAll("[data-index]");
    if (pages.length > 0) {
      return Math.max(...Array.from(pages).map(p => parseInt(p.dataset.index, 10) || 0));
    }
    return null;
  }

  // ─── Image Selectors ──────────────────────────────────────────────────────
  // All known patterns for Yandex Doc Viewer page images.

  const IMG_SELECTOR = [
    "img[src*='name=bg-']",
    "img[src*='htmlimage']",
    "img[src*='docviewer']",
    ".js-doc-page img",
    "[data-index] img",
    "[class*='pages_'] img",
  ].join(", ");

  function countImages() {
    return document.querySelectorAll(IMG_SELECTOR).length;
  }

  // ─── Scroll to Load All Pages ─────────────────────────────────────────────

  async function triggerLazyLoad() {
    const scrollEl = findScrollable();
    const viewH = scrollEl.clientHeight || window.innerHeight;
    const step = Math.max(300, Math.floor(viewH * 0.75));
    const delay = 250;
    const totalPages = detectTotalPages();
    let lastTop = -1;
    let stallCount = 0;
    let pos = 0;

    while (true) {
      scrollEl.scrollTop = pos;
      await sleep(delay);

      const loaded = countImages();
      sendProgress({
        phase: "scrolling",
        loaded,
        total: totalPages || "?",
        scrollPercent: scrollEl.scrollHeight > scrollEl.clientHeight
          ? Math.min(100, Math.round(
              (scrollEl.scrollTop / (scrollEl.scrollHeight - scrollEl.clientHeight)) * 100
            ))
          : 100,
      });

      const cur = scrollEl.scrollTop;
      if (cur === lastTop) {
        stallCount++;
        if (stallCount >= 4) break;
      } else {
        stallCount = 0;
      }
      lastTop = cur;
      pos += step;

      if (totalPages && loaded >= totalPages) break;
      if (pos > scrollEl.scrollHeight + step) break;
    }

    scrollEl.scrollTop = 0;
    await sleep(400);
  }

  // ─── Wait for Images ──────────────────────────────────────────────────────

  async function waitForImages() {
    const imgs = Array.from(document.querySelectorAll(IMG_SELECTOR));
    for (let i = 0; i < imgs.length; i++) {
      const img = imgs[i];
      if (!img.complete || img.naturalWidth === 0) {
        await new Promise(resolve => {
          const t = setTimeout(resolve, 8000);
          img.addEventListener("load",  () => { clearTimeout(t); resolve(); }, { once: true });
          img.addEventListener("error", () => { clearTimeout(t); resolve(); }, { once: true });
        });
      }
      sendProgress({ phase: "loading", loaded: i + 1, total: imgs.length, scrollPercent: 100 });
    }
  }

  // ─── Collect Image URLs ───────────────────────────────────────────────────

  function collectPageImages() {
    const allImgs = Array.from(document.querySelectorAll(IMG_SELECTOR));
    const byIndex = new Map();

    for (const img of allImgs) {
      const rawUrl = img.currentSrc || img.src || "";
      if (!rawUrl || rawUrl.startsWith("data:") || rawUrl.length < 10) continue;

      let pageIdx;
      const bgMatch = rawUrl.match(/name=bg-(\d+)\.png/i);
      if (bgMatch) {
        pageIdx = parseInt(bgMatch[1], 10);
      } else {
        const pageEl = img.closest("[data-index]");
        pageIdx = pageEl ? parseInt(pageEl.dataset.index, 10) - 1 : allImgs.indexOf(img);
      }
      if (isNaN(pageIdx) || pageIdx < 0) pageIdx = allImgs.indexOf(img);

      if (byIndex.has(pageIdx)) continue;

      // Prefer the 2× srcset URL for maximum quality
      let url = rawUrl;
      if (img.srcset) {
        const twox = img.srcset.split(",").map(s => s.trim()).find(s => s.endsWith(" 2x"));
        if (twox) {
          let candidate = twox.replace(/\s+2x$/, "").trim();
          // Resolve relative URLs against the current document
          if (!candidate.startsWith("http")) {
            try { candidate = new URL(candidate, location.href).href; } catch (_) {}
          }
          if (candidate.startsWith("http")) url = candidate;
        }
      }

      byIndex.set(pageIdx, {
        url,
        width:  img.naturalWidth  || parseInt(img.getAttribute("width"))  || 794,
        height: img.naturalHeight || parseInt(img.getAttribute("height")) || 1124,
        pageIndex: pageIdx + 1,
      });
    }

    return Array.from(byIndex.entries())
      .sort(([a], [b]) => a - b)
      .map(([, v]) => v);
  }

  // ─── Main Download Flow ───────────────────────────────────────────────────

  async function downloadPDF() {
    try {
      sendProgress({ phase: "starting", loaded: 0, total: "?", scrollPercent: 0 });

      // Wait for the viewer DOM to fully initialize (React app may still be hydrating)
      sendProgress({ phase: "starting", loaded: 0, total: "?", scrollPercent: 0 });
      const ready = await waitForViewerDOM(20000);
      if (!ready) {
        sendError("Document viewer did not initialize. Please wait for the page to finish loading and try again.");
        return;
      }

      // 1. Extract & translate title
      const rawTitle = extractDocumentTitle();
      sendProgress({ phase: "title", rawTitle });

      const { folderName, filename } = getFolderAndFilename(rawTitle);
      sendProgress({ phase: "translated", folderName, filename });

      // 2. Scroll to trigger lazy loading of all pages
      await triggerLazyLoad();

      // 3. Wait for loaded images to fully decode
      await waitForImages();

      // 4. Collect ordered image URL list
      const pages = collectPageImages();
      if (pages.length === 0) {
        sendError(
          "No page images found. Make sure you are on a Yandex Document Viewer page " +
          "(docs.yandex.ru/docs/view?… or docviewer.yandex.ru/view/…) and the document has finished loading."
        );
        return;
      }

      sendProgress({ phase: "building", loaded: 0, total: pages.length, scrollPercent: 100 });

      // 5. Hand off to background service worker for PDF assembly + download
      chrome.runtime.sendMessage({
        type: "BUILD_PDF",
        pages,
        folderName,
        filename,
      }, () => {
        if (chrome.runtime.lastError) {
          sendError(chrome.runtime.lastError.message);
        }
      });

    } catch (err) {
      console.error("[YandexPDFDownloader]", err);
      sendError(err.message || String(err));
    }
  }

  // ─── Message Listener ─────────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type !== "START_DOWNLOAD") return;

    if (isViewerFrame()) {
      sendResponse({ accepted: true });
      downloadPDF();
    } else {
      sendResponse({ accepted: false });
    }
    return true; // keep channel open for async response
  });

})();
