# PDFSplit

A lean web app for splitting scanned magazine PDFs back into single, correctly-ordered portrait pages.

Live: https://vegolasse.github.io/pdfsplit/

## What it does

You have an **A5-format, saddle-stitched magazine**. You removed the staples, separated each sheet at the center seam, and scanned every flat sheet **double-sided**. The result is a PDF where each scan contains two A5 pages side-by-side in booklet-imposed order:

```
Page 1  next to  Page N
Page 2  next to  Page N-1
Page 3  next to  Page N-2
...
```

PDFSplit converts this into a new PDF where:

- Every output page contains **only one A5 magazine page**, cropped from the scan
- Each cropped half is **scaled up to fill a full A4 portrait page**
- Output pages are in **correct linear reading order** — 1, 2, 3, …, N
- All output pages have consistent A4 portrait dimensions

### How the split works

For each scanned page:

1. The scan is rendered through **pdf.js** at **600 dpi**, which produces an upright image regardless of any rotation or quirks in the source PDF. **No rotation logic is applied** — orientation is whatever pdf.js produces.
2. Each visual half is rendered **directly into its own half-sized canvas** (via a viewport translation transform) so that we never allocate a full-page 600-dpi canvas — important on iPadOS / iOS where there is a hard per-canvas pixel-count limit.
3. Each half is encoded as **JPEG** and the canvas is freed before the next half is processed.
4. Halves are **reordered** from booklet imposition into linear reading order:
   - even scan i (outer side):  visual-left → page N−i,  visual-right → page i+1
   - odd  scan i (inner side):  visual-left → page i+1,  visual-right → page N−i
5. Each half is placed on a fresh **A4 portrait** output page, scaled to fill while preserving aspect ratio.

Progress is reported live in the Split tab as a progress bar with “Generating page X of Y”.

## Features

- 📄 Upload a PDF, see all pages previewed
- ✂️ One-tap split into the correctly-ordered A4-portrait PDF, with a live progress bar
- 🔁 Tab between **Original** and **Split**
- ⬇️ Download the result
- 💾 Last uploaded PDF is remembered locally (IndexedDB, up to 100 MB)
- 🌍 i18n with auto-detection — English, Svenska, Deutsch, Español, Français
- ⚙️ Settings: **Also generate text (OCR)** — adds a searchable invisible text layer via Tesseract.js
- 📱 Designed for iPad in portrait, also great on phones and laptops
- 🫧 macOS-style liquid-glass UI with large, accessible touch targets

## Tech

- [Vite](https://vitejs.dev/) + TypeScript
- [pdf.js](https://mozilla.github.io/pdf.js/) renders previews and rasterizes each half at 600 dpi
- [pdf-lib](https://pdf-lib.js.org/) builds the output PDF: embeds the JPEG halves onto A4 portrait pages and overlays invisible OCR text
- [Tesseract.js](https://github.com/naptha/tesseract.js) (loaded lazily) provides the optional OCR pass
- [idb-keyval](https://github.com/jakearchibald/idb-keyval) for IndexedDB persistence
- No UI framework — plain HTML, CSS, and TS

## Run locally

Requires Node 20+.

```bash
npm install
npm run dev      # http://localhost:5173/pdfsplit/
```

## Build

```bash
npm run build
npm run preview  # serves the production build
```

## Deploy

Pushing to `main` triggers `.github/workflows/deploy.yml`, which builds and publishes to GitHub Pages. In the repo settings, enable Pages with source = "GitHub Actions".

The Vite `base` is set to `/pdfsplit/` in `vite.config.ts`. If you fork to a different repo name, change that value.

## Project structure

```
src/
├── main.ts                 bootstrap
├── styles.css              theme
├── app/                    state, storage, DOM helpers
├── pdf/                    pdf.js loader, page renderer, split algorithm
├── ui/                     header, tabs, preview, toast, settings modal
└── i18n/                   t() + dictionaries (en/sv/de/es/fr)
```

Everything is modular so new features (drag-and-drop, manual reordering, OCR, PWA, ...) can be added without touching the rest.

## Settings

- **Also generate text (OCR)** *(off by default)*: when enabled, every cropped half is run through [Tesseract.js](https://github.com/naptha/tesseract.js) before being JPEG-encoded. The recognised words are added to the output PDF as **invisible text** (PDF text rendering-mode 3) positioned to match each word's bounding box, so the result is **searchable and selectable** while looking visually identical to the non-OCR output. The OCR language is picked from the detected app language (`sv→swe`, `de→deu`, `es→spa`, `fr→fra`, default `eng`). Tesseract.js and the language data are downloaded lazily on first use.

Rendering is fixed at **600 dpi** and the output is JPEG-encoded — high enough to be visually indistinguishable from a clean scan, while keeping file sizes manageable.

## Notes

- If the input has an odd number of scan pages, PDFSplit still processes it and shows a warning — the result may include an unmatched half.
- Standard duplex scan order is assumed (sheet-1 outer, sheet-1 inner, sheet-2 outer, sheet-2 inner, …).
- No rotation is applied by PDFSplit. Whatever orientation pdf.js produces from the source is what you get.

## License

MIT

