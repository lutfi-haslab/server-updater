#!/usr/bin/env bun
/**
 * METDesk Dedicated Auto-Update Server & Object Storage (Bun & Docker Target)
 * Serves release metadata and physical installer binaries (.dmg, .exe).
 * Runs natively on Bun for production Docker container deployments.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ACTIVE_SESSIONS, isRequestAuthenticated as checkAuth } from "./auth.ts";
import {
  corsHeaders,
  getBaseUrl,
  handleUpdateRequest,
  jsonResponse,
  maybeAutoUpdateRelease as autoUpdateRelease
} from "./handler.ts";
import { FileReleaseStore, formatReleaseDate } from "./release/file.ts";
import { LocalStorageProvider, ObjectStorage } from "./storage/local.ts";
import type { ReleaseData, SessionInfo, StoredObject } from "./types.ts";

export const SERVER_DIR = path.resolve(import.meta.dir, "..");

export function loadEnvFile(filePath: string) {
  if (!fs.existsSync(filePath)) return;
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const idx = trimmed.indexOf("=");
      if (idx !== -1) {
        const key = trimmed.slice(0, idx).trim();
        let val = trimmed.slice(idx + 1).trim();
        if (
          (val.startsWith('"') && val.endsWith('"')) ||
          (val.startsWith("'") && val.endsWith("'"))
        ) {
          val = val.slice(1, -1);
        }
        if (key && process.env[key] === undefined) {
          process.env[key] = val;
        }
      }
    }
  } catch {}
}

// Automatically load .env from server directory or project root
loadEnvFile(path.join(SERVER_DIR, ".env"));
loadEnvFile(path.join(SERVER_DIR, "..", ".env"));

export { ACTIVE_SESSIONS };

export function getAdminUsername(): string {
  return (process.env.ADMIN_USERNAME || "admin").trim();
}

export function getAdminPassword(): string {
  return process.env.ADMIN_PASSWORD !== undefined
    ? process.env.ADMIN_PASSWORD.trim()
    : "admin123";
}

export function getUploadAuthKey(): string {
  return (process.env.UPLOAD_AUTH_KEY || "").trim();
}

export function getBinariesDir(): string {
  const envDir = (
    process.env.STORAGE_DIR ||
    process.env.STORAGE_PATH ||
    process.env.BINARIES_DIR ||
    ""
  ).trim();
  if (envDir) {
    if (path.isAbsolute(envDir)) return envDir;
    const stripped = envDir.replace(/^\.\/update-server\//, "");
    const candidate = path.resolve(SERVER_DIR, stripped);
    if (fs.existsSync(candidate) || stripped === "binaries") return candidate;
    return path.resolve(SERVER_DIR, "..", envDir);
  }
  return path.join(SERVER_DIR, "binaries");
}

export function getReleaseFilePath(): string {
  const envPath = (process.env.RELEASE_FILE || "").trim();
  if (envPath) {
    if (path.isAbsolute(envPath)) return envPath;
    const stripped = envPath.replace(/^\.\/update-server\//, "");
    return path.resolve(SERVER_DIR, stripped);
  }
  return path.join(SERVER_DIR, "release.json");
}

export { formatReleaseDate };

export function createSampleBinary(storageDir: string, filename: string, sizeMb: number): string {
  fs.mkdirSync(storageDir, { recursive: true });
  const target = path.join(storageDir, filename);
  const sizeBytes = sizeMb * 1024 * 1024;

  if (filename.endsWith(".dmg") && process.platform === "darwin") {
    const tmpDir = path.join(storageDir, `.tmp_build_${Date.now()}`);
    const tmpDmg = path.join(storageDir, `.tmp_out_${Date.now()}.dmg`);
    fs.mkdirSync(tmpDir, { recursive: true });

    try {
      if (fs.existsSync(tmpDmg)) {
        fs.unlinkSync(tmpDmg);
      }

      const createRes = spawnSync(
        "hdiutil",
        [
          "create",
          "-size",
          `${sizeMb}m`,
          "-fs",
          "HFS+",
          "-volname",
          "METDesk Installer",
          "-type",
          "SPARSE",
          tmpDmg
        ],
        { encoding: "utf-8" }
      );

      const sparsePath = tmpDmg + ".sparseimage";
      if (createRes.status === 0 && fs.existsSync(sparsePath)) {
        const attachRes = spawnSync(
          "hdiutil",
          ["attach", sparsePath, "-nobrowse", "-mountrandom", "/tmp"],
          { encoding: "utf-8" }
        );

        let mountPoint: string | null = null;
        if (attachRes.status === 0) {
          const match = attachRes.stdout.match(/\/tmp\/[^\n\r]+/);
          if (match) mountPoint = match[0].trim();
        }

        if (mountPoint && fs.existsSync(mountPoint)) {
          const appRoot = path.join(mountPoint, "METDesk.app");
          const macosDir = path.join(appRoot, "Contents", "MacOS");
          const resDir = path.join(appRoot, "Contents", "Resources");

          fs.mkdirSync(macosDir, { recursive: true });
          fs.mkdirSync(resDir, { recursive: true });

          const infoPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>
  <string>METDesk</string>
  <key>CFBundleDisplayName</key>
  <string>METDesk Client</string>
  <key>CFBundleIdentifier</key>
  <string>com.hasdev.metdesk</string>
  <key>CFBundleVersion</key>
  <string>2.3.0</string>
  <key>CFBundleShortVersionString</key>
  <string>2.3.0</string>
  <key>CFBundleExecutable</key>
  <string>METDesk</string>
</dict>
</plist>`;
          fs.writeFileSync(path.join(appRoot, "Info.plist"), infoPlist, "utf-8");

          const runnerScript = `#!/bin/bash
osascript -e 'display dialog "METDesk Auto-Update Sample Binary" buttons {"OK"} default button "OK"'
exit 0`;
          const runnerPath = path.join(macosDir, "METDesk");
          fs.writeFileSync(runnerPath, runnerScript, "utf-8");
          fs.chmodSync(runnerPath, 0o755);

          try {
            fs.symlinkSync("/Applications", path.join(mountPoint, "Applications"));
          } catch {}

          spawnSync("hdiutil", ["detach", mountPoint, "-force"]);
        }

        spawnSync(
          "hdiutil",
          [
            "convert",
            sparsePath,
            "-format",
            "UDZO",
            "-imagekey",
            "zlib-level=9",
            "-o",
            tmpDmg
          ],
          { encoding: "utf-8" }
        );

        try {
          fs.unlinkSync(sparsePath);
        } catch {}

        if (fs.existsSync(tmpDmg)) {
          if (fs.existsSync(target)) {
            fs.unlinkSync(target);
          }
          fs.renameSync(tmpDmg, target);
          return target;
        }
      }
    } catch {} finally {
      try {
        if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {}
    }
  }

  // Cross-platform raw stub
  const fd = fs.openSync(target, "w");
  if (filename.endsWith(".exe")) {
    fs.writeSync(fd, Buffer.from("MZ\x90\x00\x03\x00\x00\x00\x04\x00\x00\x00\xff\xff\x00\x00"));
    const stub = Buffer.alloc(1024, 0);
    stub.write("This program cannot be run in DOS mode.\r\r\n$");
    fs.writeSync(fd, stub);
  } else if (filename.endsWith(".dmg")) {
    fs.writeSync(fd, Buffer.from("koly\x00\x00\x00\x04\x00\x00\x02\x00\x00\x00\x00\x00"));
    const stub = Buffer.alloc(512, 0);
    fs.writeSync(fd, stub);
  }

  const currentSize = fs.fstatSync(fd).size;
  if (currentSize < sizeBytes) {
    const remaining = sizeBytes - currentSize;
    const chunkSize = 64 * 1024;
    const chunk = Buffer.alloc(chunkSize, 0);
    let written = 0;
    while (written < remaining) {
      const writeSize = Math.min(chunkSize, remaining - written);
      fs.writeSync(fd, chunk, 0, writeSize);
      written += writeSize;
    }
  }
  fs.closeSync(fd);
  return target;
}

export function ensureMockBinariesExist(storageDir: string) {
  const mocks = [
    { filename: "METDesk-2.3.0.dmg", sizeMb: 2 },
    { filename: "METDesk-2.3.0-setup.exe", sizeMb: 2 },
    { filename: "METDesk-2.2.0.dmg", sizeMb: 2 },
    { filename: "METDesk-2.2.0-setup.exe", sizeMb: 2 },
    { filename: "METDesk-2.1.5.dmg", sizeMb: 1 },
    { filename: "METDesk-2.1.0-setup.exe", sizeMb: 1 }
  ];

  for (const { filename, sizeMb } of mocks) {
    const p = path.join(storageDir, filename);
    if (!fs.existsSync(p)) {
      createSampleBinary(storageDir, filename, sizeMb);
    }
  }
}

export function loadReleaseData(releaseFilePath: string = getReleaseFilePath()): ReleaseData {
  const store = new FileReleaseStore(releaseFilePath);
  return store.getRelease();
}

export function saveReleaseData(
  releaseFilePath: string = getReleaseFilePath(),
  data: ReleaseData
) {
  const store = new FileReleaseStore(releaseFilePath);
  store.saveRelease(data);
}

export function isRequestAuthenticated(req: Request): boolean {
  return checkAuth(req, {
    adminUsername: getAdminUsername(),
    adminPassword: getAdminPassword(),
    uploadAuthKey: getUploadAuthKey()
  });
}

export { corsHeaders, jsonResponse, getBaseUrl };

export function maybeAutoUpdateRelease(
  filename: string,
  fileInfo: StoredObject,
  searchParams: URLSearchParams,
  baseUrl: string,
  releaseFilePath: string = getReleaseFilePath()
): ReleaseData | null {
  const store = new FileReleaseStore(releaseFilePath);
  // Synchronous wrapper around autoUpdateRelease
  const data = store.getRelease();
  const updateFlag = searchParams.get("update_release")?.toLowerCase();
  if (updateFlag !== "true" && updateFlag !== "1" && updateFlag !== "yes") {
    return null;
  }

  let platformParam = searchParams.get("platform")?.toLowerCase() || "";
  if (!platformParam) {
    if (filename.endsWith(".dmg") || filename.endsWith(".pkg")) {
      platformParam = "macos";
    } else if (filename.endsWith(".exe") || filename.endsWith(".msi")) {
      platformParam = "windows";
    }
  }

  if (platformParam !== "macos" && platformParam !== "windows") {
    return null;
  }

  let versionParam = searchParams.get("version")?.trim() || "";
  if (!versionParam) {
    const verMatch = filename.match(/(\d+\.\d+\.\d+)/);
    if (verMatch) {
      versionParam = verMatch[1];
    }
  }

  if (versionParam) {
    data.version = versionParam;
  }

  const typeParam = searchParams.get("type")?.toLowerCase();
  if (typeParam && ["minor", "major", "patch"].includes(typeParam)) {
    data.type = typeParam;
  }

  const summaryParam = searchParams.get("summary");
  if (summaryParam) {
    data.summary = summaryParam;
  }

  if (!data.downloads) {
    data.downloads = {};
  }

  data.downloads[platformParam] = {
    url: `${baseUrl}/storage/${filename}`,
    filename,
    size: Math.floor(fileInfo.size_bytes / 1024),
    sizeBytes: fileInfo.size_bytes,
    sizeUnit: "KB",
    sha256: fileInfo.sha256 || ""
  };
  data.releaseDate = formatReleaseDate();

  store.saveRelease(data);
  console.log(
    `[RELEASE] Automatically updated release.json for ${platformParam} -> ${filename} (v${data.version})`
  );
  return data;
}

export interface ServerOptions {
  port?: number;
  storageDir?: string;
  releaseFilePath?: string;
  adminHtmlPath?: string;
  enableLogging?: boolean;
}

export function getLanIpAddress(): string | null {
  try {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name] || []) {
        if (iface.family === "IPv4" && !iface.internal) {
          return iface.address;
        }
      }
    }
  } catch {}
  return null;
}

export function getPortFromArgs(): number | undefined {
  const args = process.argv.slice(2);
  const portIdx = args.findIndex((arg) => arg === "--port" || arg === "-p");
  if (portIdx !== -1 && args[portIdx + 1]) {
    const parsed = parseInt(args[portIdx + 1], 10);
    if (!isNaN(parsed) && parsed > 0) return parsed;
  }
  for (const arg of args) {
    if (arg.startsWith("--port=")) {
      const parsed = parseInt(arg.split("=")[1], 10);
      if (!isNaN(parsed) && parsed > 0) return parsed;
    }
  }
  return undefined;
}

export function createUpdateServer(options: ServerOptions = {}) {
  const port = options.port !== undefined ? options.port : parseInt(process.env.PORT || "3001", 10);
  const storageDir = options.storageDir || getBinariesDir();
  const releaseFilePath = options.releaseFilePath || getReleaseFilePath();
  const adminHtmlPath = options.adminHtmlPath || path.join(SERVER_DIR, "admin.html");
  const enableLogging = options.enableLogging ?? false;

  const storage = new ObjectStorage(storageDir);
  const releaseStore = new FileReleaseStore(releaseFilePath);

  const server = Bun.serve({
    port,
    async fetch(req) {
      const startTime = performance.now();
      const res = await handleUpdateRequest(req, {
        storage,
        release: releaseStore,
        adminHtml: () => {
          if (fs.existsSync(adminHtmlPath)) {
            return fs.readFileSync(adminHtmlPath, "utf-8");
          }
          throw new Error("Admin HTML file not found");
        },
        adminUsername: getAdminUsername(),
        adminPassword: getAdminPassword(),
        uploadAuthKey: getUploadAuthKey(),
        port: server.port,
        sampleBinaryGenerator: (filename, sizeMb) => {
          createSampleBinary(storageDir, filename, sizeMb);
        }
      });

      if (enableLogging) {
        const elapsed = (performance.now() - startTime).toFixed(1);
        const url = new URL(req.url);
        const timeStr = new Date().toLocaleTimeString();
        console.log(`[${timeStr}] ${req.method} ${url.pathname} ${res.status} (${elapsed}ms)`);
      }

      return res;
    }
  });

  return {
    server,
    storage,
    port: server.port,
    stop: () => server.stop()
  };
}

export function run() {
  const cliPort = getPortFromArgs();
  const port = cliPort || parseInt(process.env.PORT || "3001", 10);
  const storageDir = getBinariesDir();
  const releaseFile = getReleaseFilePath();

  if (process.env.SEED_MOCKS === "true") {
    ensureMockBinariesExist(storageDir);
  }

  const { server } = createUpdateServer({
    port,
    storageDir,
    releaseFilePath: releaseFile,
    enableLogging: true
  });

  const uploadKey = getUploadAuthKey();
  const adminPassword = getAdminPassword();
  const openPort = server.port;
  const lanIp = getLanIpAddress();

  console.log("\n========================================================");
  console.log("   🚀 Update Server & Dedicated Object Storage");
  console.log("   (Bun & TypeScript Production Engine)");
  console.log("========================================================\n");

  console.log(`[STATUS]   🟢 Server is listening (Port ${openPort} OPEN)`);
  console.log(`[LOCAL]    ➜ http://localhost:${openPort}`);
  if (lanIp) {
    console.log(`[NETWORK]  ➜ http://${lanIp}:${openPort}`);
  }
  console.log(`\n[ENDPOINTS]`);
  console.log(`  • Web Admin Dashboard : http://localhost:${openPort}/`);
  console.log(`  • Update Metadata API : http://localhost:${openPort}/updates`);
  console.log(`  • Object Storage API  : http://localhost:${openPort}/storage`);
  console.log(`  • Healthcheck Endpoint: http://localhost:${openPort}/health`);
  console.log(`\n[STORAGE]  Artifacts folder : ${storageDir}`);
  console.log(`[RELEASE]  Metadata file    : ${releaseFile}`);

  if (!uploadKey && !adminPassword) {
    console.log("\n[SECURITY] ⚠️  Running with open authentication (no ADMIN_PASSWORD or UPLOAD_AUTH_KEY set).");
  } else {
    console.log("\n[SECURITY] 🔒 Authentication enabled for Web Admin and CI/CD uploads.");
  }
  console.log("\n--- [Incoming Request Logs] ---");
}

if (import.meta.main) {
  run();
}
