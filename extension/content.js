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
    // Fallback: strip Yandex suffix from page title
    const titleEl = document.querySelector("title");
    if (titleEl) {
      return titleEl.textContent
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

  function findScrollable() {
    const selectors = [
      ".html_Y5jrDemZ5zdvkEcuAzQc",
      ".pages_mRGnD_fBeRK6yJ33usXQ",
      ".main_Ctw6fyhTXBLVKjW8bAPw",
      "[class*='pages_']",
      "[class*='html_']",
      "[class*='viewer']",
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && el.scrollHeight > el.clientHeight + 100) return el;
    }
    // Generic: deepest overflowing element
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
    // "1 из 16" style counter
    const counter = document.querySelector("[class*='pageCounter']");
    if (counter) {
      const m = counter.textContent.match(/(\d+)\s*(?:из|of)\s*(\d+)/i);
      if (m) return parseInt(m[2], 10);
    }
    // Numeric input with max attribute
    const input = document.querySelector("input[type='number'][min]");
    if (input) {
      const max = input.getAttribute("max");
      if (max) return parseInt(max, 10);
    }
    // Count data-index elements
    const pages = document.querySelectorAll("[data-index]");
    if (pages.length > 0) {
      return Math.max(...Array.from(pages).map(p => parseInt(p.dataset.index, 10) || 0));
    }
    return null;
  }

  // ─── Scroll to Load All Pages ─────────────────────────────────────────────

  async function triggerLazyLoad() {
    const scrollEl = findScrollable();
    const step = Math.max(300, Math.floor((scrollEl.clientHeight || window.innerHeight) * 0.75));
    const delay = 220;
    const totalPages = detectTotalPages();
    let lastScrollTop = -1;
    let stallCount = 0;
    let pos = 0;

    while (true) {
      scrollEl.scrollTop = pos;
      await sleep(delay);

      const loaded = document.querySelectorAll(
        "img[src*='name=bg-'], img[src*='htmlimage'], img[src*='docviewer']"
      ).length;

      sendProgress({
        phase: "scrolling",
        loaded,
        total: totalPages || "?",
        scrollPercent: scrollEl.scrollHeight > scrollEl.clientHeight
          ? Math.min(100, Math.round((scrollEl.scrollTop / (scrollEl.scrollHeight - scrollEl.clientHeight)) * 100))
          : 100,
      });

      const cur = scrollEl.scrollTop;
      if (cur === lastScrollTop) {
        stallCount++;
        if (stallCount >= 4) break;
      } else {
        stallCount = 0;
      }
      lastScrollTop = cur;
      pos += step;

      if (totalPages && loaded >= totalPages) break;
      if (pos > scrollEl.scrollHeight + step) break;
    }

    scrollEl.scrollTop = 0;
    await sleep(400);
  }

  // ─── Wait for Images ──────────────────────────────────────────────────────

  async function waitForImages() {
    const selector = "img[src*='name=bg-'], img[src*='htmlimage'], img[src*='docviewer']";
    const imgs = Array.from(document.querySelectorAll(selector));

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
    const selector = "img[src*='name=bg-'], img[src*='htmlimage'], img[src*='docviewer']";
    const allImgs = Array.from(document.querySelectorAll(selector));
    const byIndex = new Map();

    for (const img of allImgs) {
      const rawUrl = img.currentSrc || img.src || "";
      if (!rawUrl) continue;

      // Determine page index
      let pageIdx;
      const bgMatch = rawUrl.match(/name=bg-(\d+)\.png/i);
      if (bgMatch) {
        pageIdx = parseInt(bgMatch[1], 10);
      } else {
        const pageEl = img.closest("[data-index]");
        pageIdx = pageEl ? parseInt(pageEl.dataset.index, 10) - 1 : allImgs.indexOf(img);
      }
      if (isNaN(pageIdx)) pageIdx = allImgs.indexOf(img);

      if (byIndex.has(pageIdx)) continue;

      // Prefer 2× URL for quality
      let url = rawUrl;
      if (img.srcset) {
        const twox = img.srcset.split(",").map(s => s.trim()).find(s => s.endsWith(" 2x"));
        if (twox) {
          let candidate = twox.replace(/\s+2x$/, "").trim();
          if (candidate.startsWith("./") || candidate.startsWith("/")) {
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

  // ─── Main Flow ────────────────────────────────────────────────────────────

  async function downloadPDF() {
    try {
      sendProgress({ phase: "starting", loaded: 0, total: "?", scrollPercent: 0 });

      // 1. Extract & translate title
      const rawTitle = extractDocumentTitle();
      sendProgress({ phase: "title", rawTitle });

      const { folderName, filename } = getFolderAndFilename(rawTitle);
      sendProgress({ phase: "translated", folderName, filename });

      // 2. Scroll page to force lazy loading
      await triggerLazyLoad();

      // 3. Wait for all images
      await waitForImages();

      // 4. Collect image descriptors
      const pages = collectPageImages();
      if (pages.length === 0) {
        sendError("No page images found. Open a Yandex Document Viewer page first.");
        return;
      }

      sendProgress({ phase: "building", loaded: 0, total: pages.length, scrollPercent: 100 });

      // 5. Delegate PDF building to background service worker
      //    Background has full fetch() access + pdf-lib + chrome.downloads
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

    // Accept if this frame contains the actual viewer content
    const isViewer = !!(
      document.querySelector(".js-doc-page") ||
      document.querySelector("[data-index]") ||
      document.querySelector("[class*='orbHeadTitle']") ||
      document.querySelector("img[src*='name=bg-']") ||
      document.querySelector("img[src*='htmlimage']") ||
      document.querySelector("[class*='pages_']")
    );

    if (isViewer || msg.force) {
      sendResponse({ accepted: true });
      downloadPDF();
    } else {
      sendResponse({ accepted: false });
    }
    return true;
  });

})();
