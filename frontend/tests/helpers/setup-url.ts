/** Puts the page at `path` (with an optional fragment) the way a visitor arriving from a link would be. */
export function visit(path: string): void {
  window.history.replaceState(null, "", path);
}
