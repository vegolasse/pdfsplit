import { defineConfig } from 'vite';
import { copyFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Copy pdf.js worker into /public so it ships with the right base path.
// We use the *legacy* build of both the lib and the worker: it's the same
// engine as the modern build (transpiled + polyfilled at build time) so it
// runs on slightly older JS runtimes — most importantly iOS Safari 18, which
// doesn't yet implement Map.prototype.getOrInsertComputed, Math.sumPrecise,
// etc. that the modern build uses.
const workerSrc = resolve(__dirname, 'node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs');
const workerDest = resolve(__dirname, 'public/pdf.worker.min.mjs');
try {
  mkdirSync(resolve(__dirname, 'public'), { recursive: true });
  copyFileSync(workerSrc, workerDest);
} catch (e) {
  // non-fatal at config eval; build will still fail loudly if missing
  console.warn('[pdfsplit] could not copy pdf.js worker:', (e as Error).message);
}

export default defineConfig({
  base: '/pdfsplit/',
  build: {
    target: 'es2022',
    sourcemap: true,
  },
});

