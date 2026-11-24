import type { Page } from "@playwright/test";

const enabled = () => process.env.BOS_T107_PROFILE === "1";
const requestIds = new WeakMap<Page, { url: string; id: string }[]>();

export async function installTiming(page: Page) {
  if (!enabled()) return;
  const ids: { url: string; id: string }[] = [];
  requestIds.set(page, ids);
  page.on("response", (response) => {
    const id = response.headers()["x-request-id"];
    if (id && new URL(response.url()).pathname.startsWith("/api/v1/")) ids.push({ url: response.url(), id });
  });
  await page.addInitScript(() => {
    performance.setResourceTimingBufferSize(1000);
    const tasks: { start: number; duration: number }[] = [];
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) tasks.push({ start: entry.startTime, duration: entry.duration });
    });
    observer.observe({ type: "longtask", buffered: true });
    Object.assign(window, { t107LongTasks: tasks });
  });
}

export async function captureTiming(page: Page, ms: number, interaction: boolean, check: string, locale: string, repeat: number) {
  if (!enabled()) return;
  const timing = await page.evaluate(({ duration, fromAction, ids }) => {
    const round = (n: number) => Math.round(n * 10) / 10;
    const trigger = fromAction ? performance.getEntriesByName("t107-trigger")[0]?.startTime : 0;
    const [nav] = performance.getEntriesByType("navigation") as PerformanceNavigationTiming[];
    if (trigger === undefined || !nav) throw new Error("Missing T107 timing origin");
    const ready = trigger + duration;
    const resources = (performance.getEntriesByType("resource") as PerformanceResourceTiming[])
      .filter((entry) => entry.startTime <= ready);
    const apps = resources.filter((entry) => new URL(entry.name).pathname.startsWith("/api/v1/"));
    const assets = resources.filter((entry) => new URL(entry.name).pathname.startsWith("/_next/static/"));
    const shape = (entry: PerformanceResourceTiming) => ({
      start: round(entry.startTime), request: round(entry.requestStart), firstByte: round(entry.responseStart),
      end: round(entry.responseEnd), bytes: entry.encodedBodySize,
    });
    return {
      trigger: round(trigger), ready: round(ready), nav: shape(nav),
      domInteractive: round(nav.domInteractive), domContentLoaded: round(nav.domContentLoadedEventEnd),
      paints: Object.fromEntries(performance.getEntriesByType("paint").map((entry) => [entry.name, round(entry.startTime)])),
      assets: assets.map((entry) => ({ name: new URL(entry.name).pathname, ...shape(entry) })),
      api: apps.map((entry) => ({ path: new URL(entry.name).pathname, search: new URL(entry.name).searchParams.has("q"),
        id: ids.find((pair) => pair.url === entry.name)?.id, ...shape(entry) })),
      rsc: resources.filter((entry) => new URL(entry.name).searchParams.has("_rsc")).map(shape),
      longTasks: ((window as Window & { t107LongTasks?: { start: number; duration: number }[] }).t107LongTasks ?? [])
        .filter((task) => task.start <= ready).map((task) => ({ start: round(task.start), duration: round(task.duration) })),
    };
  }, { duration: ms, fromAction: interaction, ids: requestIds.get(page) ?? [] });
  console.log(`T107_PROFILE ${JSON.stringify({ check, locale, repeat, ...timing })}`);
}
