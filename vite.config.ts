import { defineConfig } from 'vite';
import { copyFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Copy pdf.js worker into /public so it ships with the right base path.
const workerSrc = resolve(__dirname, 'node_modules/pdfjs-dist/build/pdf.worker.min.mjs');
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

