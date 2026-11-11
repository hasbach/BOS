import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

// `next dev` rewrites next-env.d.ts to point at its own build folder. The test server uses
// .next-e2e, so put the file back for the development server's folder (.next); otherwise the type
// check would depend on the test folder existing.
export default function globalTeardown(): void {
  // `next dev` also drops an AGENTS.md of its own into the project; it is not part of this repository.
  try {
    const agents = resolve(__dirname, "..", "AGENTS.md");
    if (readFileSync(agents, "utf-8").startsWith("<!-- BEGIN:nextjs-agent-rules -->")) rmSync(agents);
  } catch {
    // Not there: nothing to remove.
  }
  const file = resolve(__dirname, "..", "next-env.d.ts");
  try {
    const before = readFileSync(file, "utf-8");
    const after = before.replaceAll("./.next-e2e/", "./.next/");
    if (after !== before) writeFileSync(file, after);
  } catch {
    // The file is generated and ignored by git; a missing one is not a problem.
  }
}
