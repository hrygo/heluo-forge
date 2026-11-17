import { createElement, Fragment } from "react";

// The Host exports React only. Use its public API instead of bundling a runtime
// tied to React 18 private internals (the Host may supply a newer React).
export { Fragment };
export function jsx(type: Parameters<typeof createElement>[0], props: Record<string, unknown> | null, key?: string) {
  return createElement(type, key === undefined ? props : { ...props, key });
}
export const jsxs = jsx;
