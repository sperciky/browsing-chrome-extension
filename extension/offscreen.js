// offscreen.js
// Runs in an offscreen document (Chrome 116+) where URL.createObjectURL is available.
// The service worker stores the PDF Uint8Array in IndexedDB under key "pending",
// then sends OFFSCREEN_DOWNLOAD with the target filename.
// This page reads the bytes, creates a blob: URL, triggers the download, and closes itself.

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

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type !== "OFFSCREEN_DOWNLOAD") return;

  openIDB()
    .then(db => loadFromIDB(db).then(bytes => ({ db, bytes })))
    .then(({ db, bytes }) => {
      if (!bytes) throw new Error("No PDF data found in IndexedDB");

      const blob = new Blob([bytes], { type: "application/pdf" });
      const url = URL.createObjectURL(blob);

      return new Promise((resolve, reject) => {
        chrome.downloads.download(
          { url, filename: msg.filename, saveAs: false, conflictAction: "uniquify" },
          (downloadId) => {
            URL.revokeObjectURL(url);
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message));
            } else {
              resolve({ db, downloadId });
            }
          }
        );
      });
    })
    .then(({ db }) => deleteFromIDB(db))
    .then(() => {
      chrome.runtime.sendMessage({ type: "OFFSCREEN_DONE" });
      return chrome.offscreen.closeDocument();
    })
    .catch(err => {
      chrome.runtime.sendMessage({ type: "OFFSCREEN_ERROR", message: err.message });
      chrome.offscreen.closeDocument().catch(() => {});
    });
});
