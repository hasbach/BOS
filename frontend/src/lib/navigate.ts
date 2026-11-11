// Full-page navigation, used where the page must reload (language switch). Kept in one place so
// tests can replace it.
export function hardNavigate(url: string): void {
  window.location.assign(url);
}
