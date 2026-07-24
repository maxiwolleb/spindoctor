// Vitest setup for jsdom: Vuetify's layout/display system touches a couple of
// browser APIs jsdom doesn't implement, so we stub the minimum needed for a
// component mount to run without throwing.

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver
}

if (typeof window.matchMedia !== "function") {
  window.matchMedia = (query: string): MediaQueryList =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList
}

// jsdom's CSS.supports throws "not implemented" for most feature queries;
// Vuetify probes it for progressive-enhancement checks, so make it a no-op.
if (typeof global.CSS === "undefined" || typeof global.CSS.supports !== "function") {
  // @ts-expect-error minimal jsdom shim, not a full CSSOM implementation
  global.CSS = { supports: (): boolean => false }
}
