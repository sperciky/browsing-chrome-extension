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

  function isViewerFrame() {
    // Primary: hostname check — the viewer iframe always runs on docviewer.yandex.ru
    if (location.hostname === "docviewer.yandex.ru") return true;
    // Fallback: stable DOM markers present in the viewer
    return !!(
      document.querySelector(".js-doc-page") ||
      document.querySelector(".js-doc-html") ||
      document.querySelector("[data-index]") ||
      document.querySelector("[class*='orbHeadTitle']") ||
      document.querySelector("[class*='pages_']")
    );
  }

  // Wait up to maxMs for the viewer DOM to appear.
  async function waitForViewerDOM(maxMs = 20000) {
    const interval = 300;
    let elapsed = 0;
    while (elapsed < maxMs) {
      if (
        document.querySelector("[data-index]") ||
        document.querySelector(".js-doc-html") ||
        document.querySelector("[class*='pages_']") ||
        document.querySelector(".js-doc-page")
      ) return true;
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
      const text = el && el.textContent.trim();
      if (text) return text;
    }
    const t = document.querySelector("title");
    return t
      ? t.textContent.replace(/\s*[-–|]\s*Яндекс.*/i, "").replace(/\s*[-–|]\s*Yandex.*/i, "").trim()
      : "document";
  }

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

  function findScrollContainer() {
    // Stable class (.js-doc-html) is the primary scroll container in Yandex viewer
    const exactSelectors = [
      ".js-doc-html",                            // stable, confirmed
      ".html_Y5jrDemZ5zdvkEcuAzQc",             // hash-obfuscated (may change)
      ".main_Ctw6fyhTXBLVKjW8bAPw",
      "[class*='html_']",
      "[class*='main_']",
      "[class*='pages_']",
    ];
    for (const sel of exactSelectors) {
      const el = document.querySelector(sel);
      if (el && el.scrollHeight > el.clientHeight + 50) return el;
    }
    // Generic overflow scan
    const all = Array.from(document.querySelectorAll("*"));
    for (let i = all.length - 1; i >= 0; i--) {
      const el = all[i];
      const st = window.getComputedStyle(el);
      if ((st.overflowY === "scroll" || st.overflowY === "auto") &&
          el.scrollHeight > el.clientHeight + 100) return el;
    }
    return null; // will fall back to window.scrollTo
  }

  function detectTotalPages() {
    const counter = document.querySelector("[class*='pageCounter']");
    if (counter) {
      const m = counter.textContent.match(/(\d+)\s*(?:из|of)\s*(\d+)/i);
      if (m) return parseInt(m[2], 10);
    }
    const input = document.querySelector("input[type='number'][min]");
    if (input && input.getAttribute("max")) return parseInt(input.getAttribute("max"), 10);
    const pages = document.querySelectorAll("[data-index]");
    if (pages.length > 0) {
      return Math.max(...Array.from(pages).map(p => parseInt(p.dataset.index, 10) || 0));
    }
    return null;
  }

  // ─── Image Selectors ──────────────────────────────────────────────────────

  const IMG_SELECTOR = [
    "img[src*='name=bg-']",
    "img[src*='htmlimage']",
    "img[src*='docviewer']",
    ".js-doc-page img",
    "[data-index] img",
    "[class*='pages_'] img",
    "[class*='page_pdf'] img",
  ].join(", ");

  function countImages() {
    const imgs = document.querySelectorAll(IMG_SELECTOR);
    // Count only those with a real src (not placeholders)
    let realCount = 0;
    imgs.forEach(img => {
      const s = img.src || "";
      if (s && !s.startsWith("data:") && s.length > 15) realCount++;
    });
    return realCount;
  }

  // ─── Scroll to Load All Pages ─────────────────────────────────────────────

  async function triggerLazyLoad() {
    const scrollEl = findScrollContainer();
    const totalPages = detectTotalPages();
    const delay = 220;

    // Use the detected container OR window.scrollTo (both, to be safe)
    const getScrollTop = () => scrollEl ? scrollEl.scrollTop : window.scrollY;
    const getScrollHeight = () => scrollEl
      ? scrollEl.scrollHeight
      : document.documentElement.scrollHeight;
    const getClientHeight = () => scrollEl
      ? scrollEl.clientHeight
      : window.innerHeight;

    const step = Math.max(300, Math.floor(getClientHeight() * 0.75));

    let lastTop = -1;
    let stallCount = 0;
    let pos = 0;

    while (true) {
      // Scroll both the container and window — covers all Yandex viewer variants
      if (scrollEl) scrollEl.scrollTop = pos;
      window.scrollTo(0, pos);

      await sleep(delay);

      const loaded = countImages();
      const scrollH = getScrollHeight();
      const clientH = getClientHeight();
      const curTop  = getScrollTop();

      sendProgress({
        phase: "scrolling",
        loaded,
        total: totalPages || "?",
        scrollPercent: scrollH > clientH
          ? Math.min(100, Math.round((curTop / (scrollH - clientH)) * 100))
          : 100,
      });

      if (curTop === lastTop) {
        stallCount++;
        if (stallCount >= 4) break;
      } else {
        stallCount = 0;
      }
      lastTop = curTop;
      pos += step;

      if (totalPages && loaded >= totalPages) break;
      if (pos > scrollH + step) break;
    }

    // Scroll back to top
    if (scrollEl) scrollEl.scrollTop = 0;
    window.scrollTo(0, 0);
    await sleep(400);
  }

  // ─── Wait for Images ──────────────────────────────────────────────────────

  async function waitForImages() {
    const imgs = Array.from(document.querySelectorAll(IMG_SELECTOR))
      .filter(img => { const s = img.src || ""; return s && !s.startsWith("data:") && s.length > 15; });

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
      if (!rawUrl || rawUrl.startsWith("data:") || rawUrl.length < 15) continue;

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

      // Prefer 2× srcset URL for quality
      let url = rawUrl;
      if (img.srcset) {
        const twox = img.srcset.split(",").map(s => s.trim()).find(s => s.endsWith(" 2x"));
        if (twox) {
          let candidate = twox.replace(/\s+2x$/, "").trim();
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

      // Wait for the viewer React app to hydrate
      const ready = await waitForViewerDOM(20000);
      if (!ready) {
        sendError(
          "Document viewer did not initialize within 20 seconds. " +
          "Please wait for the page to fully load and try again."
        );
        return;
      }

      // Extract & translate title
      const rawTitle = extractDocumentTitle();
      sendProgress({ phase: "title", rawTitle });
      const { folderName, filename } = getFolderAndFilename(rawTitle);
      sendProgress({ phase: "translated", folderName, filename });

      // Scroll to trigger lazy loading
      await triggerLazyLoad();

      // Wait for decoded images
      await waitForImages();

      // Collect image URLs with up to 3 retries (some lazy loaders are slow)
      let pages = collectPageImages();
      for (let attempt = 0; attempt < 3 && pages.length === 0; attempt++) {
        await sleep(1000);
        await waitForImages();
        pages = collectPageImages();
      }

      if (pages.length === 0) {
        // Diagnostics to help debug
        const allImgs = document.querySelectorAll("img");
        const pageEls = document.querySelectorAll("[data-index]");
        sendError(
          `No page images detected after scrolling. ` +
          `Found ${allImgs.length} total <img> elements and ${pageEls.length} page containers on this frame (${location.hostname}). ` +
          `Make sure the document has finished loading and is visible before clicking Download.`
        );
        return;
      }

      sendProgress({ phase: "building", loaded: 0, total: pages.length, scrollPercent: 100 });

      // Delegate PDF assembly to background service worker
      chrome.runtime.sendMessage({
        type: "BUILD_PDF",
        pages,
        folderName,
        filename,
      }, () => {
        if (chrome.runtime.lastError) sendError(chrome.runtime.lastError.message);
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
    return true;
  });

})();
