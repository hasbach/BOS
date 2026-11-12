import "@testing-library/jest-dom/vitest";
import { cleanup, configure } from "@testing-library/react";
import { afterEach } from "vitest";

// findBy and waitFor give up after 1 second by default. The first render of a file takes about that
// long on a busy machine (right after the backend suite), so a slow start looked like a failure.
// Waiting longer costs nothing when the page is ready: they return as soon as it is.
configure({ asyncUtilTimeout: 5000 });

afterEach(() => {
  cleanup();
});
