/** Tiny pub/sub store with shallow-equality update notifications. */
export type Listener<T> = (state: T, prev: T) => void;

export class Store<T extends object> {
  private state: T;
  private listeners = new Set<Listener<T>>();

  constructor(initial: T) { this.state = initial; }

  get(): T { return this.state; }

  set(patch: Partial<T>): void {
    const prev = this.state;
    const next = { ...prev, ...patch };
    this.state = next;
    this.listeners.forEach((l) => l(next, prev));
  }

  subscribe(listener: Listener<T>): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export type View = 'original' | 'converted';

export type Settings = {
  fidelity: 'lossless' | 'raster';
  dpi: number;
};

export type AppState = {
  fileName: string | null;
  originalBytes: Uint8Array | null;
  convertedBytes: Uint8Array | null;
  view: View;
  settings: Settings;
};

export const DEFAULT_SETTINGS: Settings = { fidelity: 'lossless', dpi: 300 };

export const store = new Store<AppState>({
  fileName: null,
  originalBytes: null,
  convertedBytes: null,
  view: 'original',
  settings: { ...DEFAULT_SETTINGS },
});

