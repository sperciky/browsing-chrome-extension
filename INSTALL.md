# Yandex Docs PDF Downloader — Installation

## Prerequisites
- Google Chrome 116+ (Manifest V3 support)

## Installation (Chrome Developer Mode)

1. Open Chrome and navigate to `chrome://extensions`
2. Enable **Developer mode** (toggle in the top-right corner)
3. Click **Load unpacked**
4. Select the `extension/` folder from this repository
5. The extension icon appears in the Chrome toolbar

## Usage

1. Open a Yandex Document Viewer page
   - e.g. `https://docs.yandex.ru/docs/view?...`
   - or `https://docviewer.yandex.ru/view/...`
2. Click the **PDF Downloader** extension icon in the toolbar
3. Click **Download PDF**
4. Watch the progress bar — the extension will:
   - Auto-scroll the page to load all lazy images
   - Translate the Russian title to English
   - Assemble all pages into an A4 PDF
   - Save it automatically to your Downloads folder

## Output Structure

Downloads are saved inside your Chrome Downloads directory under:

```
output/
  <English Title>/
    <English Title>.pdf
```

Example:
```
output/
  Pecan Gianduja/
    Pecan Gianduja.pdf
```

## File Structure

```
extension/
  manifest.json       — Chrome Extension Manifest V3
  background.js       — Service worker (download orchestration)
  content.js          — Page content script (scrolling + image collection)
  popup.html          — Extension popup UI
  popup.js            — Popup logic + live progress display
  pdfBuilder.js       — PDF assembly using pdf-lib
  translator.js       — Russian→English dictionary + transliteration
  scrollLoader.js     — Scroll-based lazy load utilities
  lib/
    pdf-lib.min.js    — pdf-lib 1.17.1 (bundled, no external requests)
```

## Troubleshooting

- **"No page images found"** — Make sure you're on the Yandex Docs viewer, not just the file listing. The page must show the document preview.
- **Images are blurry** — The extension uses the 2× srcset URLs for maximum quality.
- **Download fails** — Some corporate Yandex Docs require authentication cookies. Make sure you're logged in.
- **Extension not responding** — Refresh the Yandex Docs page and try again (content scripts need to reinitialise).
