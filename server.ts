#!/usr/bin/env bun
import { run } from "./src/server.ts";

if (import.meta.main) {
  run();
}

export * from "./src/server.ts";
export * from "./src/storage.ts";
export * from "./src/types.ts";
