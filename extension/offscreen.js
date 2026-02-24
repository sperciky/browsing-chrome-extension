// offscreen.js
// Runs in an offscreen document (Chrome 116+).
// chrome.downloads is NOT available here — only runtime, storage, i18n, extension are.
//
// PREPARE_BLOB  → reads PDF bytes from IndexedDB, creates a blob: URL, returns it to SW.
//                 SW then calls chrome.downloads.download() with that URL.
// CLEANUP_OFFSCREEN → revokes the blob URL and closes this document.

function openIDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("pdf-downloader", 1);
    req.onupgradeneeded = e => e.target.result.createObjectStore("pdfs");
    req.onsuccess = e => resolve(e.target.result);
    req.onerror = e => reject(e.target.error);
  });
}

function loadFromIDB(db) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction("pdfs", "readonly");
    const req = tx.objectStore("pdfs").get("pending");
    req.onsuccess = e => resolve(e.target.result);
    req.onerror = e => reject(e.target.error);
  });
}

function deleteFromIDB(db) {
  return new Promise((resolve) => {
    const tx = db.transaction("pdfs", "readwrite");
    tx.objectStore("pdfs").delete("pending");
    tx.oncomplete = resolve;
    tx.onerror = resolve; // best-effort cleanup
  });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "PREPARE_BLOB") {
    openIDB()
      .then(db => loadFromIDB(db).then(bytes => ({ db, bytes })))
      .then(({ db, bytes }) => {
        if (!bytes) throw new Error("No PDF data found in IndexedDB");
        const blob = new Blob([bytes], { type: "application/pdf" });
        const blobUrl = URL.createObjectURL(blob);
        // Clean up IDB entry (best effort — don't block the response)
        deleteFromIDB(db).catch(() => {});
        // Return the blob URL to the SW — SW will call chrome.downloads.download()
        // Keep this document alive (don't close) until CLEANUP_OFFSCREEN arrives
        sendResponse({ ok: true, blobUrl });
      })
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true; // keep message channel open for async sendResponse
  }

  if (msg.type === "CLEANUP_OFFSCREEN") {
    if (msg.blobUrl) URL.revokeObjectURL(msg.blobUrl);
    chrome.offscreen.closeDocument().catch(() => {});
  }
});
