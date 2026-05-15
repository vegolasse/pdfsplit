/**
 * Polyfills for very new JS APIs that pdfjs-dist 5.x relies on but which
 * are missing on older / not-quite-latest browsers.
 *
 * `Map.prototype.getOrInsertComputed` is a TC39 Stage-3 proposal that landed
 * in V8 (Chrome) and very recent Safari, but NOT yet in iOS Safari (as of
 * iOS 17/18). Without this polyfill, pdf.js throws:
 *
 *   TypeError: this.#t.getOrInsertComputed is not a function
 *
 * on the first page render, which is exactly the symptom reported on iPhone.
 *
 * This file is side-effect only and is imported as the very first thing
 * from `main.ts`.
 *
 * See: https://github.com/tc39/proposal-upsert
 */

type Upsertable<K, V> = Map<K, V> & {
  getOrInsertComputed?: (key: K, factory: (key: K) => V) => V;
  getOrInsert?: (key: K, defaultValue: V) => V;
  emplace?: (
    key: K,
    handler: { insert?: (k: K, map: Map<K, V>) => V; update?: (existing: V, k: K, map: Map<K, V>) => V },
  ) => V;
};

(function installMapUpsertPolyfills() {
  const proto = Map.prototype as unknown as Upsertable<unknown, unknown>;

  if (typeof proto.getOrInsertComputed !== 'function') {
    Object.defineProperty(proto, 'getOrInsertComputed', {
      configurable: true,
      writable: true,
      value: function getOrInsertComputed<K, V>(
        this: Map<K, V>,
        key: K,
        factory: (key: K) => V,
      ): V {
        if (this.has(key)) return this.get(key) as V;
        const value = factory(key);
        this.set(key, value);
        return value;
      },
    });
  }

  if (typeof proto.getOrInsert !== 'function') {
    Object.defineProperty(proto, 'getOrInsert', {
      configurable: true,
      writable: true,
      value: function getOrInsert<K, V>(this: Map<K, V>, key: K, defaultValue: V): V {
        if (this.has(key)) return this.get(key) as V;
        this.set(key, defaultValue);
        return defaultValue;
      },
    });
  }
})();

/**
 * `Math.sumPrecise(iterable)` is a TC39 Stage-3 proposal (recent V8 / latest
 * desktop Safari). iOS 18 doesn't ship it yet, so pdfjs-dist throws:
 *
 *   TypeError: Math.sumPrecise is not a function
 *
 * The spec returns the sum of an iterable of numbers using an algorithm
 * that's exact up to double-precision rounding (Shewchuk / Neumaier
 * compensated summation). For pdf.js's use of it (summing chunk lengths)
 * plain Kahan-Neumaier summation is more than precise enough, and we
 * fall through to native if/when iOS adds it.
 *
 * Spec: https://tc39.es/proposal-math-sum/
 *   - argument MUST be iterable
 *   - every element MUST be a Number, else throw TypeError
 *   - empty iterable → -0
 *   - any NaN → NaN; mixed +∞ and -∞ → NaN; only +∞ → +∞; only -∞ → -∞
 */
(function installMathSumPrecisePolyfill() {
  const M = Math as unknown as { sumPrecise?: (values: Iterable<number>) => number };
  if (typeof M.sumPrecise === 'function') return;

  M.sumPrecise = function sumPrecise(values: Iterable<number>): number {
    if (values === null || values === undefined || typeof (values as { [Symbol.iterator]?: unknown })[Symbol.iterator] !== 'function') {
      throw new TypeError('Math.sumPrecise argument must be iterable');
    }
    let sum = 0;
    let compensation = 0; // Neumaier running compensation
    let count = 0;
    let posInf = false;
    let negInf = false;
    for (const v of values) {
      if (typeof v !== 'number') {
        throw new TypeError('Math.sumPrecise: every element must be a Number');
      }
      count++;
      if (Number.isNaN(v)) return NaN;
      if (v === Infinity) { posInf = true; continue; }
      if (v === -Infinity) { negInf = true; continue; }
      const t = sum + v;
      compensation += Math.abs(sum) >= Math.abs(v) ? (sum - t) + v : (v - t) + sum;
      sum = t;
    }
    if (posInf && negInf) return NaN;
    if (posInf) return Infinity;
    if (negInf) return -Infinity;
    if (count === 0) return -0;
    return sum + compensation;
  };
})();

