import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// The test credentials come from the repository .env (never committed), exactly as the backend
// scripts read them. Nothing here is printed.

const ENV_FILE = resolve(__dirname, "..", "..", ".env");

function readEnvFile(): Record<string, string> {
  const values: Record<string, string> = {};
  if (!existsSync(ENV_FILE)) return values;
  for (const raw of readFileSync(ENV_FILE, "utf-8").split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#") || !line.includes("=")) continue;
    const at = line.indexOf("=");
    values[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return values;
}

function need(values: Record<string, string>, name: string): string {
  const value = process.env[name] ?? values[name];
  if (!value) throw new Error(`${name} is not set in the environment or in ${ENV_FILE}`);
  return value;
}

export interface E2eEnv {
  operatorEmail: string;
  operatorPassword: string;
  demoPassword: string;
}

export function loadEnv(): E2eEnv {
  const values = readEnvFile();
  const operatorEmail = need(values, "BOS_OPERATOR_EMAILS").split(",")[0]?.trim() ?? "";
  if (operatorEmail === "") throw new Error("BOS_OPERATOR_EMAILS has no address");
  return {
    operatorEmail,
    operatorPassword: need(values, "BOS_OPERATOR_PASSWORD"),
    demoPassword: need(values, "BOS_DEMO_PASSWORD"),
  };
}
