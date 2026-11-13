#!/usr/bin/env bun
import { run } from "./src/server.ts";

const isDirectRun =
  Boolean(import.meta.main) ||
  process.env.pm_id !== undefined ||
  process.env.PM2_HOME !== undefined ||
  process.argv.some((arg) => arg.includes("server.ts"));

const isTest =
  process.env.NODE_ENV === "test" ||
  process.env.BUN_ENV === "test" ||
  process.argv.some((arg) => arg.includes("test"));

if (isDirectRun && !isTest) {
  run();
}

export * from "./src/server.ts";
export * from "./src/storage.ts";
export * from "./src/types.ts";
