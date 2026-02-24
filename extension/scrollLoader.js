// scrollLoader.js
// Handles auto-scrolling of the Yandex Document Viewer to force lazy-load all page images.
// Runs inside the page (injected via content.js / scripting.executeScript).

const ScrollLoader = (() => {
  /**
   * Find the main scrollable container of the Yandex viewer.
   * The viewer renders inside either:
   *   - An iframe (<iframe class="Docs-View__Frame">) whose document contains the pages
   *   - Directly in the page body
   * We look for known container selectors.
   */
  function findScrollContainer() {
    // Attempt 1: Yandex Docs HTML viewer scroll container
    const selectors = [
      ".html_Y5jrDemZ5zdvkEcuAzQc",   // html viewer class
      ".pages_mRGnD_fBeRK6yJ33usXQ",   // pages wrapper
      ".page-pdf-wrapper",
      ".viewer-body",
      ".doc-viewer-body",
      ".b-page__content",
      "main",
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && el.scrollHeight > el.clientHeight) return el;
    }
    // Fallback: find deepest element with overflow scroll/auto that has lots of height
    const allEls = Array.from(document.querySelectorAll("*"));
    for (const el of allEls.reverse()) {
      const style = window.getComputedStyle(el);
      const overflow = style.overflowY;
      if ((overflow === "scroll" || overflow === "auto") && el.scrollHeight > el.clientHeight + 100) {
        return el;
      }
    }
    return document.documentElement;
  }

  /**
   * Find the iframe that hosts the actual viewer, if present.
   * Returns the iframe's contentDocument or null.
   */
  function findViewerDocument() {
    // Check if we're already inside the viewer iframe
    if (document.querySelector(".js-doc-page") || document.querySelector(".pages_mRGnD_fBeRK6yJ33usXQ")) {
      return document;
    }
    // Look for the viewer iframe
    const iframes = Array.from(document.querySelectorAll("iframe"));
    for (const iframe of iframes) {
      try {
        const doc = iframe.contentDocument || iframe.contentWindow.document;
        if (doc && (doc.querySelector(".js-doc-page") || doc.querySelector("[data-index]"))) {
          return doc;
        }
      } catch (e) {
        // Cross-origin iframe – skip
      }
    }
    return document;
  }

  /**
   * Wait for an image element to finish loading.
   */
  function waitForImage(img, timeout = 10000) {
    return new Promise((resolve) => {
      if (img.complete && img.naturalWidth > 0) {
        resolve(true);
        return;
      }
      const timer = setTimeout(() => resolve(false), timeout);
      img.addEventListener("load", () => { clearTimeout(timer); resolve(true); }, { once: true });
      img.addEventListener("error", () => { clearTimeout(timer); resolve(false); }, { once: true });
    });
  }

  /**
   * Count how many pages the document has.
   * Tries multiple selectors and heuristics.
   */
  function detectTotalPages(viewerDoc) {
    // From page counter text like "1 из 16" or "1 of 16"
    const counterEl = viewerDoc.querySelector("[class*='pageCounter']");
    if (counterEl) {
      const match = counterEl.textContent.match(/(\d+)\s*(?:из|of)\s*(\d+)/i);
      if (match) return parseInt(match[2], 10);
    }

    // From input aria attributes
    const pageInput = viewerDoc.querySelector("input[aria-label*='страниц'], input[aria-label*='page'], input[min][type='number']");
    if (pageInput) {
      const max = pageInput.getAttribute("max");
      if (max) return parseInt(max, 10);
    }

    // From existing js-doc-page elements
    const pages = viewerDoc.querySelectorAll("[data-index]");
    if (pages.length > 0) {
      const indices = Array.from(pages).map(p => parseInt(p.dataset.index, 10)).filter(n => !isNaN(n));
      if (indices.length > 0) return Math.max(...indices);
    }

    // From bg-N.png pattern in src attributes – find max N
    const imgs = viewerDoc.querySelectorAll("img[src*='name=bg-']");
    let maxPage = 0;
    imgs.forEach(img => {
      const m = img.src.match(/name=bg-(\d+)\.png/);
      if (m) maxPage = Math.max(maxPage, parseInt(m[1], 10) + 1);
    });
    if (maxPage > 0) return maxPage;

    return null; // unknown
  }

  /**
   * Scroll the viewer through all pages to trigger lazy loading.
   * Reports progress via onProgress(currentPage, totalPages).
   * Returns array of image URLs in page order.
   */
  async function scrollAndCollect(onProgress) {
    const viewerDoc = findViewerDocument();
    const scrollEl = (() => {
      const selectors = [
        ".html_Y5jrDemZ5zdvkEcuAzQc",
        ".pages_mRGnD_fBeRK6yJ33usXQ",
        ".main_Ctw6fyhTXBLVKjW8bAPw",
      ];
      for (const sel of selectors) {
        const el = viewerDoc.querySelector(sel);
        if (el) return el;
      }
      return viewerDoc.documentElement;
    })();

    const totalPages = detectTotalPages(viewerDoc);
    const scrollStep = 600; // px per step
    const scrollDelay = 300; // ms between scrolls
    const maxScrollAttempts = 500;

    let lastScrollTop = -1;
    let stallCount = 0;

    const sleep = ms => new Promise(r => setTimeout(r, ms));

    // Phase 1: Scroll down incrementally
    for (let attempt = 0; attempt < maxScrollAttempts; attempt++) {
      scrollEl.scrollTop += scrollStep;
      await sleep(scrollDelay);

      const currentScrollTop = scrollEl.scrollTop;
      const currentImages = viewerDoc.querySelectorAll("img[src*='name=bg-'], img[src*='htmlimage']");

      if (onProgress) {
        const loaded = currentImages.length;
        onProgress({ phase: "scrolling", loaded, total: totalPages || "?", scrollPercent: Math.round((currentScrollTop / (scrollEl.scrollHeight - scrollEl.clientHeight)) * 100) });
      }

      // Detect stall (no more scrolling possible)
      if (currentScrollTop === lastScrollTop) {
        stallCount++;
        if (stallCount >= 3) break;
      } else {
        stallCount = 0;
      }
      lastScrollTop = currentScrollTop;

      // If we know the total and have loaded all, done
      if (totalPages && currentImages.length >= totalPages) break;
    }

    // Phase 2: Scroll back to top then wait for all images
    scrollEl.scrollTop = 0;
    await sleep(500);

    // Phase 3: Wait for all visible images to finish loading
    const allImgs = Array.from(viewerDoc.querySelectorAll("img[src*='name=bg-'], img[src*='htmlimage']"));
    for (let i = 0; i < allImgs.length; i++) {
      await waitForImage(allImgs[i]);
      if (onProgress) {
        onProgress({ phase: "loading", loaded: i + 1, total: allImgs.length, scrollPercent: 100 });
      }
    }

    // Phase 4: Collect all image URLs sorted by page index
    return collectImageURLs(viewerDoc);
  }

  /**
   * Collect and sort all page image URLs from the viewer document.
   * Returns an array of { url, width, height, pageIndex } objects.
   */
  function collectImageURLs(viewerDoc) {
    const doc = viewerDoc || document;

    // Strategy 1: Pages with data-index + img src containing bg-N.png
    const pageContainers = Array.from(doc.querySelectorAll("[data-index]"))
      .filter(el => {
        const idx = parseInt(el.dataset.index, 10);
        return !isNaN(idx);
      })
      .sort((a, b) => parseInt(a.dataset.index) - parseInt(b.dataset.index));

    if (pageContainers.length > 0) {
      const result = [];
      for (const container of pageContainers) {
        const pageIdx = parseInt(container.dataset.index, 10);
        // Find the primary image inside this page container
        const img = container.querySelector("img[src*='name=bg-'], img[src*='htmlimage']");
        if (img) {
          const url = img.src || img.currentSrc;
          // Prefer 2x version from srcset for quality
          const srcset = img.srcset;
          let finalUrl = url;
          if (srcset) {
            const parts = srcset.split(",").map(s => s.trim());
            const twox = parts.find(p => p.endsWith("2x"));
            if (twox) {
              finalUrl = twox.replace(/\s+2x$/, "").trim();
              // Make absolute if relative
              if (finalUrl.startsWith("./") || finalUrl.startsWith("/")) {
                finalUrl = new URL(finalUrl, doc.baseURI || window.location.href).href;
              }
            }
          }
          result.push({
            url: finalUrl,
            width: img.naturalWidth || parseInt(img.getAttribute("width")) || 794,
            height: img.naturalHeight || parseInt(img.getAttribute("height")) || 1124,
            pageIndex: pageIdx,
          });
        }
      }
      if (result.length > 0) return result;
    }

    // Strategy 2: Fallback – collect all bg-N.png images, sort by N
    const allImgs = Array.from(doc.querySelectorAll("img[src*='name=bg-'], img[src*='htmlimage']"));
    const bgMap = new Map();
    for (const img of allImgs) {
      const url = img.src || img.currentSrc || "";
      const m = url.match(/name=bg-(\d+)\.png/);
      const idx = m ? parseInt(m[1], 10) : bgMap.size;
      if (!bgMap.has(idx)) {
        bgMap.set(idx, {
          url,
          width: img.naturalWidth || parseInt(img.getAttribute("width")) || 794,
          height: img.naturalHeight || parseInt(img.getAttribute("height")) || 1124,
          pageIndex: idx + 1,
        });
      }
    }

    return Array.from(bgMap.entries())
      .sort(([a], [b]) => a - b)
      .map(([, v]) => v);
  }

  return { scrollAndCollect, collectImageURLs, findViewerDocument, detectTotalPages };
})();

if (typeof window !== "undefined") {
  window.ScrollLoader = ScrollLoader;
}
