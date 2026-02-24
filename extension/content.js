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
      if (el && el.scrollHeight > el.clientHeight + 50) {
        console.log(`[content] scroll container found via selector: "${sel}" scrollHeight=${el.scrollHeight} clientHeight=${el.clientHeight}`);
        return el;
      }
    }
    // Generic overflow scan
    const all = Array.from(document.querySelectorAll("*"));
    for (let i = all.length - 1; i >= 0; i--) {
      const el = all[i];
      const st = window.getComputedStyle(el);
      if ((st.overflowY === "scroll" || st.overflowY === "auto") &&
          el.scrollHeight > el.clientHeight + 100) {
        console.log(`[content] scroll container found via overflow scan: <${el.tagName} class="${el.className}"> scrollHeight=${el.scrollHeight}`);
        return el;
      }
    }
    console.warn("[content] no scroll container found — will fall back to window.scrollTo");
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

  // ─── Shadow-DOM-Aware Image Helpers ──────────────────────────────────────
  //
  // Yandex Docs renders each page inside a declarative shadow root:
  //   <div data-index="N">
  //     <div class="__page-N">          ← shadow host
  //       <template shadowrootmode="open">
  //         <img src="./htmlimage?...">  ← lives here, invisible to
  //       </template>                      normal querySelectorAll
  //     </div>
  //   </div>
  //
  // To reach those images we must walk .shadowRoot on every descendant.

  // Return the first <img> inside any open shadow root within `container`,
  // or fall back to a plain light-DOM img.
  function getImgFromPageContainer(container) {
    // Walk all light-DOM descendants; each may have an open shadow root.
    for (const el of container.querySelectorAll("*")) {
      if (el.shadowRoot) {
        const img = el.shadowRoot.querySelector("img");
        if (img) return img;
      }
    }
    // Unlikely, but handle shadow root directly on the container
    if (container.shadowRoot) {
      const img = container.shadowRoot.querySelector("img");
      if (img) return img;
    }
    // Fallback: plain img in light DOM
    return container.querySelector("img");
  }

  function isRealImageSrc(src) {
    return src && !src.startsWith("data:") && src.length > 15;
  }

  function countImages() {
    let n = 0;
    for (const container of document.querySelectorAll("[data-index]")) {
      const img = getImgFromPageContainer(container);
      if (img && isRealImageSrc(img.src)) n++;
    }
    return n;
  }

  // ─── Scroll to Load All Pages ─────────────────────────────────────────────

  async function triggerLazyLoad() {
    const scrollEl = findScrollContainer();
    const totalPages = detectTotalPages();
    console.log(`[content] triggerLazyLoad: totalPages=${totalPages} scrollEl=${scrollEl ? scrollEl.tagName + '.' + scrollEl.className.slice(0,40) : 'null(window fallback)'}`);
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
    // Collect imgs from both shadow DOM and light DOM page containers
    const imgs = [];
    for (const container of document.querySelectorAll("[data-index]")) {
      const img = getImgFromPageContainer(container);
      if (img && isRealImageSrc(img.src)) imgs.push(img);
    }

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
    const byIndex = new Map();
    const pageContainers = Array.from(document.querySelectorAll("[data-index]"));
    console.log(`[content] collectPageImages: ${pageContainers.length} [data-index] containers found`);

    for (const container of pageContainers) {
      const dataIdx = container.dataset.index;
      const img = getImgFromPageContainer(container);
      if (!img) {
        console.log(`[content]   data-index=${dataIdx}: no <img> found (shadow or light DOM)`);
        continue;
      }

      const rawUrl = img.currentSrc || img.src || "";
      if (!isRealImageSrc(rawUrl)) {
        console.log(`[content]   data-index=${dataIdx}: img found but src is empty/data-URI: "${rawUrl.slice(0,60)}"`);
        continue;
      }

      // Page index from bg-N.png URL or from data-index attribute
      let pageIdx;
      const bgMatch = rawUrl.match(/name=bg-(\d+)\.png/i);
      if (bgMatch) {
        pageIdx = parseInt(bgMatch[1], 10);
      } else {
        pageIdx = parseInt(container.dataset.index, 10) - 1;
      }
      if (isNaN(pageIdx) || pageIdx < 0) pageIdx = 0;
      if (byIndex.has(pageIdx)) continue;

      // Prefer 2× srcset URL for higher quality
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

      console.log(`[content]   data-index=${dataIdx} → pageIdx=${pageIdx}: ${url.slice(0, 80)}${url.length > 80 ? "…" : ""} (${img.naturalWidth}×${img.naturalHeight})`);

      byIndex.set(pageIdx, {
        url,
        width:  img.naturalWidth  || parseInt(img.getAttribute("width"))  || 794,
        height: img.naturalHeight || parseInt(img.getAttribute("height")) || 1124,
        pageIndex: pageIdx + 1,
      });
    }

    const result = Array.from(byIndex.entries())
      .sort(([a], [b]) => a - b)
      .map(([, v]) => v);
    console.log(`[content] collectPageImages result: ${result.length} pages collected`);
    return result;
  }

  // ─── Main Download Flow ───────────────────────────────────────────────────

  async function downloadPDF() {
    const t0 = performance.now();
    try {
      sendProgress({ phase: "starting", loaded: 0, total: "?", scrollPercent: 0 });

      // Wait for the viewer React app to hydrate
      const tWait = performance.now();
      const ready = await waitForViewerDOM(20000);
      console.log(`[timing log] waitForViewerDOM: ${(performance.now() - tWait).toFixed(0)}ms — ready=${ready}`);
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
      const tScroll = performance.now();
      await triggerLazyLoad();
      console.log(`[timing log] triggerLazyLoad: ${(performance.now() - tScroll).toFixed(0)}ms`);

      // Wait for decoded images
      const tImgWait = performance.now();
      await waitForImages();
      console.log(`[timing log] waitForImages (first pass): ${(performance.now() - tImgWait).toFixed(0)}ms`);

      // Collect image URLs with up to 3 retries (some lazy loaders are slow)
      let pages = collectPageImages();
      for (let attempt = 0; attempt < 3 && pages.length === 0; attempt++) {
        console.log(`[timing log] collectPageImages returned 0 — retry ${attempt + 1}/3`);
        await sleep(1000);
        await waitForImages();
        pages = collectPageImages();
      }

      console.log(`[timing log] page collection done: ${pages.length} pages in ${(performance.now() - t0).toFixed(0)}ms total`);

      if (pages.length === 0) {
        const pageEls = Array.from(document.querySelectorAll("[data-index]"));
        // Count imgs in both light DOM and shadow DOM for the diagnostic
        let shadowImgCount = 0;
        for (const c of pageEls) { if (getImgFromPageContainer(c)) shadowImgCount++; }
        const lightImgCount = document.querySelectorAll("img").length;
        sendError(
          `No page images detected after scrolling. ` +
          `${pageEls.length} page containers found, ` +
          `${lightImgCount} light-DOM <img> + ${shadowImgCount} shadow-DOM <img> on ${location.hostname}. ` +
          `Make sure the document has finished loading and is visible before clicking Download.`
        );
        return;
      }

      sendProgress({ phase: "building", loaded: 0, total: pages.length, scrollPercent: 100 });

      console.log(`[timing log] sending BUILD_PDF to SW — ${pages.length} pages`);
      // Delegate PDF assembly to background service worker
      chrome.runtime.sendMessage({
        type: "BUILD_PDF",
        pages,
        folderName,
        filename,
      }, () => {
        if (chrome.runtime.lastError) sendError(chrome.runtime.lastError.message);
        else console.log(`[timing log] BUILD_PDF message accepted by SW`);
      });

    } catch (err) {
      console.error("[YandexPDFDownloader]", err);
      sendError(err.message || String(err));
    }
  }

  // ─── Image fetch proxy (called by background service worker) ─────────────
  //
  // The background SW runs from chrome-extension:// origin, so its fetch()
  // may not carry the page's SameSite cookies and can't reach unlisted CDNs.
  // We proxy image fetches through the content script, which shares the tab's
  // full cookie context.  WebP images (unsupported by pdf-lib) are converted
  // to JPEG here via canvas before the bytes are returned.

  function bufToBase64(buf) {
    const u8 = new Uint8Array(buf);
    let binary = "";
    const CHUNK = 32768;
    for (let i = 0; i < u8.length; i += CHUNK) {
      binary += String.fromCharCode(...u8.subarray(i, Math.min(u8.length, i + CHUNK)));
    }
    return btoa(binary);
  }

  function normalizeImageBuffer(buf) {
    const u8 = new Uint8Array(buf);
    // WebP magic: RIFF????WEBP
    const isWebP = u8.length > 11 &&
      u8[0] === 0x52 && u8[1] === 0x49 && u8[2] === 0x46 && u8[3] === 0x46 &&
      u8[8] === 0x57 && u8[9] === 0x45 && u8[10] === 0x42 && u8[11] === 0x50;
    if (!isWebP) return Promise.resolve(buf);
    return new Promise((resolve, reject) => {
      const blob = new Blob([buf], { type: "image/webp" });
      const blobUrl = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement("canvas");
        canvas.width  = img.naturalWidth  || 794;
        canvas.height = img.naturalHeight || 1124;
        canvas.getContext("2d").drawImage(img, 0, 0);
        URL.revokeObjectURL(blobUrl);
        canvas.toBlob(
          b2 => b2.arrayBuffer().then(resolve).catch(reject),
          "image/jpeg", 0.92
        );
      };
      img.onerror = () => { URL.revokeObjectURL(blobUrl); reject(new Error("WebP decode failed")); };
      img.src = blobUrl;
    });
  }

  // ─── Message Listener ─────────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === "FETCH_IMAGE") {
      console.log(`[content] FETCH_IMAGE: ${msg.url}`);
      fetch(msg.url, { credentials: "include" })
        .then(r => {
          console.log(`[content] FETCH_IMAGE status=${r.status} ok=${r.ok} url=${msg.url}`);
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.arrayBuffer();
        })
        .then(buf => normalizeImageBuffer(buf))
        .then(buf => {
          console.log(`[content] FETCH_IMAGE returning ${buf.byteLength} bytes for ${msg.url}`);
          sendResponse({ ok: true, imageData: bufToBase64(buf) });
        })
        .catch(e => {
          console.warn(`[content] FETCH_IMAGE failed: ${e.message} url=${msg.url}`);
          sendResponse({ ok: false, error: e.message });
        });
      return true; // keep message channel open for async response
    }

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
