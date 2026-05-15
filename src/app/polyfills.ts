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

