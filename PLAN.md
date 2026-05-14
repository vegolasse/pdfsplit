# PDFSplit – Project Plan

A lean, modern web app for splitting scanned magazine PDFs back into single, correctly-ordered portrait pages. Built with **Vite + TypeScript**, plain HTML/CSS/JS on the client (no UI framework), **pdf.js** for rendering/parsing and **pdf-lib** for producing the output PDF. Designed primarily for **iPad in portrait** mode, also works on phones and laptops. Deployed to **GitHub Pages**.

---

## Core Concept

Input: an **A5 saddle-stitched magazine** that was destapled and scanned **double-sided**. Each scan contains two A5 magazine pages side-by-side in booklet-imposed order:

```
Page 1  next to  Page N
Page 2  next to  Page N-1
Page 3  next to  Page N-2
...
```

Output: a PDF with `N` **A4 portrait** pages in correct linear reading order — page 1, 2, 3, …, N. Each output page contains one cropped A5 half, scaled up to fill the A4 page.

### Split pipeline

For each scanned page (in 0-indexed scan order `i`, with `S` scans and `N = 2·S` magazine pages):

1. **Render** the scan via pdf.js at a **fixed 600 dpi**. pdf.js produces an upright image regardless of any rotation or scanner quirks in the source PDF — **no rotation logic is applied** in our code.
2. **Render each visual half separately** into a half-sized canvas via a viewport translation transform. This keeps each canvas under iPadOS/iOS per-canvas pixel limits and bounds peak memory.
3. **Encode** each half as JPEG, then free the canvas before continuing to the next half. A progress callback fires after every half: the Split tab shows a progress bar with “Generating page X of Y”.
4. **Reorder** halves into linear reading order using booklet imposition:
   - even scan i (outer): visual-left → page `N−i`,  visual-right → page `i+1`
   - odd  scan i (inner): visual-left → page `i+1`,  visual-right → page `N−i`
5. **Place** each half on a fresh **A4 portrait** output page (via pdf-lib), scaled to fill while preserving aspect ratio.

### Settings

- **Also generate text (OCR)** — *off by default*. When enabled, each cropped half is run through [Tesseract.js](https://github.com/naptha/tesseract.js) (loaded lazily on first use) before being JPEG-encoded. The recognised words and their bounding boxes are overlaid on the output PDF page as **invisible text** (PDF text rendering-mode 3) so the result is searchable and selectable while visually identical to the non-OCR output. OCR language is auto-picked from the detected app language (sv→swe, de→deu, es→spa, fr→fra, default eng).
- Rendering DPI is fixed at 600 and the output is JPEG; this matches typical scanner native resolution and produces sharp, manageable files.

---

## Tech Stack

- **Vite** (vanilla-ts template)
- **TypeScript** (strict)
- **pdf.js** (`pdfjs-dist`) – renders each scan to a canvas (handles rotation/quirks)
- **pdf-lib** – builds the output PDF, embedding cropped halves (PNG or JPEG) onto A4 portrait pages
- **idb-keyval** (tiny, ~600 B) – IndexedDB helper to persist the last uploaded PDF
- No UI framework. Plain DOM + CSS (with backdrop-filter for liquid-glass look).
- **GitHub Pages** via GitHub Actions

---

## Project Structure

```
pdfsplit/
├── index.html
├── vite.config.ts
├── tsconfig.json
├── package.json
├── README.md
├── PLAN.md
├── public/
│   └── pdf.worker.min.mjs        # copied from pdfjs-dist at build time
├── src/
│   ├── main.ts                   # bootstrap
│   ├── styles.css                # liquid-glass theme, layout, responsive
│   ├── app/
│   │   ├── state.ts              # tiny reactive store (pub/sub)
│   │   ├── storage.ts            # IndexedDB persistence (last PDF)
│   │   └── dom.ts                # small DOM helpers
│   ├── pdf/
│   │   ├── loader.ts             # pdf.js setup + load document
│   │   ├── renderer.ts           # render page to <canvas> for preview
│   │   └── split.ts              # the split algorithm (pdf-lib)
│   ├── ui/
│   │   ├── header.ts             # upload, split, download, lang dropdown
│   │   ├── tabs.ts               # Original / Converted tabs
│   │   ├── preview.ts            # scrollable page list
│   │   └── toast.ts              # status/errors
│   └── i18n/
│       ├── index.ts              # detect + switch + t() helper
│       ├── en.ts
│       ├── sv.ts
│       ├── de.ts
│       ├── es.ts
│       └── fr.ts
└── .github/workflows/deploy.yml  # build & deploy to Pages
```

Everything is modular so new features (rotation, manual reordering, OCR, etc.) can be slotted in.

---

## UI / UX

Layout (top → bottom):
1. **Header bar** (sticky, glass):
   - Left: app title
   - Center / left group: `Upload PDF` button, `Split` button, `Download` button (disabled until ready)
   - Right: language dropdown (🌐)
2. **Tab strip**: `Original` | `Converted` (Converted disabled until split done)
3. **Preview area**: vertical scroll of page thumbnails rendered via pdf.js. Lazy-rendered as they scroll into view.
4. **Toast / status** for feedback.

Visual style:
- Soft gradient background
- Translucent panels: `backdrop-filter: blur(20px) saturate(180%)`, subtle border, soft shadows
- Rounded corners (16–24px), generous spacing
- Tuned for iPad portrait (768–1024 px width); media queries down to phone, up to desktop
- Touch-friendly hit targets (≥44 px)
- Respects `prefers-color-scheme`

---

## i18n

- Homegrown, no library.
- `t(key, params?)` looks up dotted keys in the active dictionary, falls back to English.
- Language detection: `localStorage.lang` → `navigator.languages` → `'en'`.
- Mark translatable nodes with `data-i18n="key"` (and `data-i18n-attr` for attributes like `title`/`aria-label`); a single `applyI18n(root)` walks the DOM.
- Dropdown lists: Svenska, Deutsch, Español, Français, English.

---

## Persistence

- On upload: store `{ name, bytes: ArrayBuffer, savedAt }` under key `lastPdf` via `idb-keyval`.
- On load: if present, restore and render preview automatically.
- “Clear” action (small × on filename chip) to remove it.

---

## Deployment (GitHub Pages)

- `vite.config.ts` with `base: '/pdfsplit/'`.
- GitHub Action: on push to `main`, run `npm ci && npm run build`, upload `dist/` as Pages artifact, deploy.
- pdf.js worker copied into `public/` so it’s served from the same origin under the correct base.

---

## Phases

### Phase 0 — Scaffolding
- `npm create vite@latest . -- --template vanilla-ts`
- Add deps: `pdfjs-dist`, `pdf-lib`, `idb-keyval`
- Strict TS config, base path, worker copy
- Empty layout shell + glass CSS tokens
- GitHub Actions Pages workflow

### Phase 1 — i18n foundation
- `t()` + DOM walker
- 5 language dictionaries (minimal keys for now)
- Language dropdown wired up, persisted in `localStorage`

### Phase 2 — Upload & persistence
- File input button (hidden `<input type="file">`, styled label)
- Store last PDF in IndexedDB, restore on startup
- Filename chip with clear

### Phase 3 — Preview (Original)
- pdf.js loader (worker from `/pdfsplit/pdf.worker.min.mjs`)
- Lazy-rendered thumbnails in scroll container
- Tabs component (Original active; Converted disabled)

### Phase 4 — Split logic
- `splitMagazinePdf(bytes): Uint8Array` using pdf-lib
- For each input page: embed twice, set crop boxes for left/right halves, place at correct output index
- Unit-style sanity checks for even/odd page counts (warn if odd)

### Phase 5 — Converted preview + download
- Render the resulting PDF in the Converted tab
- Enable Download button → triggers `Blob` download with sensible filename (`<original>-split.pdf`)

### Phase 6 — Polish
- Loading states, progress for large PDFs
- Error toasts (corrupt PDF, odd page count, etc.)
- Empty state illustration / hint
- Accessibility pass (focus rings, aria-labels, keyboard nav)
- Final iPad portrait tuning

### Phase 7 — Deploy
- Push, verify Pages build, smoke-test on iPad Safari

### Future (not in v1)
- Manual page reordering / rotation
- Detect & auto-fix upside-down halves
- Multi-file batching
- PWA / offline install
- Drag-and-drop upload

---

## Open Questions

1. **Odd page count**: real magazines should have an even number of scanned sheets. If the input has an odd page count, should we (a) refuse with an error, (b) drop the last half, or (c) include a blank? *Default plan: warn + still process, leaving the unmatched half as-is.*
2. **Half orientation**: scanned magazine halves are usually already upright when the sheet is landscape (no rotation needed beyond cropping). Do you ever encounter scans where halves need a 180° rotation? If so we should add an auto/per-page rotate toggle.
3. **Output fidelity**: I plan to keep the original page content losslessly (pdf-lib crop boxes, no re-rasterization). OK? Alternative is re-rendering at a chosen DPI (smaller file but lossy).
4. **App name / title** in the header — keep as “PDFSplit”, or something else (e.g., “Magazine Unscanner”)?
5. **GitHub Pages path**: I’ll assume the repo is named `pdfsplit` so `base: '/pdfsplit/'`. Confirm?
6. **Branding**: any preferred accent color for the glass UI? Default will be a cool blue/violet gradient.
7. **Max file size**: IndexedDB can hold big blobs, but iPad Safari has quirks. Cap stored PDF at, say, 100 MB and warn above that? 

Let me know on these and I’ll proceed with Phase 0 onward.

