// pdfBuilder.js
// Builds a PDF from an ordered array of image URLs using pdf-lib.
// Must be loaded AFTER lib/pdf-lib.min.js.

const PDFBuilder = (() => {
  // A4 dimensions in points (1 pt = 1/72 inch)
  const A4_WIDTH_PT = 595.28;
  const A4_HEIGHT_PT = 841.89;

  /**
   * Fetch a URL and return an ArrayBuffer.
   * Uses fetch with CORS mode; falls back to XMLHttpRequest if needed.
   */
  async function fetchAsArrayBuffer(url) {
    // Try fetch first
    try {
      const response = await fetch(url, {
        credentials: "include",
        mode: "cors",
      });
      if (response.ok) {
        return await response.arrayBuffer();
      }
    } catch (e) {
      // fall through to XHR
    }

    // Fallback: XMLHttpRequest
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("GET", url, true);
      xhr.responseType = "arraybuffer";
      xhr.withCredentials = true;
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(xhr.response);
        } else {
          reject(new Error(`HTTP ${xhr.status} for ${url}`));
        }
      };
      xhr.onerror = () => reject(new Error(`Network error for ${url}`));
      xhr.send();
    });
  }

  /**
   * Load an image URL into an HTMLImageElement and return { dataUrl, width, height }.
   * This uses a canvas to get a data URL regardless of CORS issues (as a last resort).
   */
  async function imageToDataUrl(url, naturalWidth, naturalHeight) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => {
        const w = img.naturalWidth || naturalWidth || 794;
        const h = img.naturalHeight || naturalHeight || 1124;
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, w, h);
        try {
          const dataUrl = canvas.toDataURL("image/jpeg", 0.92);
          resolve({ dataUrl, width: w, height: h });
        } catch (e) {
          reject(new Error(`Canvas taint error for ${url}: ${e.message}`));
        }
      };
      img.onerror = () => reject(new Error(`Failed to load image: ${url}`));
      img.src = url;
    });
  }

  /**
   * Determine if an ArrayBuffer contains JPEG data.
   */
  function isJpeg(buffer) {
    const view = new Uint8Array(buffer, 0, 3);
    return view[0] === 0xFF && view[1] === 0xD8 && view[2] === 0xFF;
  }

  /**
   * Determine if an ArrayBuffer contains PNG data.
   */
  function isPng(buffer) {
    const view = new Uint8Array(buffer, 0, 8);
    return view[0] === 0x89 && view[1] === 0x50 &&
           view[2] === 0x4E && view[3] === 0x47 &&
           view[4] === 0x0D && view[5] === 0x0A &&
           view[6] === 0x1A && view[7] === 0x0A;
  }

  /**
   * Convert a PNG ArrayBuffer to JPEG via canvas.
   * Returns a Uint8Array of JPEG data.
   */
  async function pngToJpeg(pngBuffer, width, height) {
    return new Promise((resolve, reject) => {
      const blob = new Blob([pngBuffer], { type: "image/png" });
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement("canvas");
        canvas.width = img.naturalWidth || width || 794;
        canvas.height = img.naturalHeight || height || 1124;
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0);
        URL.revokeObjectURL(url);
        canvas.toBlob(blob2 => {
          blob2.arrayBuffer().then(buf => resolve(new Uint8Array(buf)));
        }, "image/jpeg", 0.92);
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("PNG decode failed")); };
      img.src = url;
    });
  }

  /**
   * Build a single PDF from an ordered list of page image descriptors.
   *
   * @param {Array<{url: string, width: number, height: number, pageIndex: number}>} pages
   * @param {Function} onProgress - callback(current, total)
   * @returns {Promise<Uint8Array>} - PDF bytes
   */
  async function buildPDF(pages, onProgress) {
    const { PDFDocument } = PDFLib;

    const pdfDoc = await PDFDocument.create();

    for (let i = 0; i < pages.length; i++) {
      const { url, width, height } = pages[i];

      if (onProgress) onProgress(i + 1, pages.length);

      let imageBytes;
      let embedFn;

      // Step 1: Try direct fetch to get raw bytes
      try {
        const buffer = await fetchAsArrayBuffer(url);
        const u8 = new Uint8Array(buffer);

        if (isJpeg(buffer)) {
          imageBytes = u8;
          embedFn = "embedJpg";
        } else if (isPng(buffer)) {
          // pdf-lib supports PNG natively
          imageBytes = u8;
          embedFn = "embedPng";
        } else {
          // Unknown format – convert via canvas
          const jpegBytes = await pngToJpeg(buffer, width, height);
          imageBytes = jpegBytes;
          embedFn = "embedJpg";
        }
      } catch (fetchErr) {
        // Step 2: Fallback – load via img element + canvas
        try {
          const { dataUrl, width: iw, height: ih } = await imageToDataUrl(url, width, height);
          const base64 = dataUrl.split(",")[1];
          const binaryStr = atob(base64);
          const bytes = new Uint8Array(binaryStr.length);
          for (let b = 0; b < binaryStr.length; b++) bytes[b] = binaryStr.charCodeAt(b);
          imageBytes = bytes;
          embedFn = "embedJpg";
        } catch (canvasErr) {
          console.error(`[PDFBuilder] Skipping page ${i + 1}: ${canvasErr.message}`);
          // Add a blank page as placeholder
          pdfDoc.addPage([A4_WIDTH_PT, A4_HEIGHT_PT]);
          continue;
        }
      }

      // Step 2: Embed image
      let embeddedImage;
      try {
        embeddedImage = await pdfDoc[embedFn](imageBytes);
      } catch (embedErr) {
        // If PNG embed fails (some PNG variants), convert to JPEG
        if (embedFn === "embedPng") {
          try {
            const blob = new Blob([imageBytes], { type: "image/png" });
            const blobUrl = URL.createObjectURL(blob);
            const { width: iw, height: ih } = await imageToDataUrl(blobUrl, width, height);
            URL.revokeObjectURL(blobUrl);
            const jpegBytes = await pngToJpeg(imageBytes.buffer, width, height);
            embeddedImage = await pdfDoc.embedJpg(jpegBytes);
          } catch (retryErr) {
            console.error(`[PDFBuilder] Embed retry failed page ${i + 1}: ${retryErr.message}`);
            pdfDoc.addPage([A4_WIDTH_PT, A4_HEIGHT_PT]);
            continue;
          }
        } else {
          console.error(`[PDFBuilder] Embed failed page ${i + 1}: ${embedErr.message}`);
          pdfDoc.addPage([A4_WIDTH_PT, A4_HEIGHT_PT]);
          continue;
        }
      }

      // Step 3: Calculate dimensions to fit A4 while preserving aspect ratio
      const imgAspect = embeddedImage.width / embeddedImage.height;
      const a4Aspect = A4_WIDTH_PT / A4_HEIGHT_PT;

      let drawW, drawH;
      if (imgAspect > a4Aspect) {
        drawW = A4_WIDTH_PT;
        drawH = A4_WIDTH_PT / imgAspect;
      } else {
        drawH = A4_HEIGHT_PT;
        drawW = A4_HEIGHT_PT * imgAspect;
      }

      const offsetX = (A4_WIDTH_PT - drawW) / 2;
      const offsetY = (A4_HEIGHT_PT - drawH) / 2;

      // Step 4: Add page and draw image
      const page = pdfDoc.addPage([A4_WIDTH_PT, A4_HEIGHT_PT]);
      page.drawImage(embeddedImage, {
        x: offsetX,
        y: offsetY,
        width: drawW,
        height: drawH,
      });
    }

    return pdfDoc.save();
  }

  return { buildPDF };
})();

if (typeof window !== "undefined") {
  window.PDFBuilder = PDFBuilder;
}
