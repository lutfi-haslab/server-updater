/**
 * Core Request Dispatcher for METDesk Update Server.
 * 100% Platform Agnostic: Runs on both Bun (Docker/Prod) and Cloudflare Workers (Dev/Preview).
 */

import path from "node:path";
import {
  ACTIVE_SESSIONS,
  createSessionToken,
  isRequestAuthenticated,
  verifySessionToken
} from "./auth.ts";
import { formatReleaseDate } from "./release/file.ts";
import type { ReleaseStore } from "./release/types.ts";
import type { StorageProvider } from "./storage/types.ts";
import {
  getAllowedExtensionsErrorMessage,
  guessContentType,
  isAllowedBinaryFilename
} from "./storage/utils.ts";
import type { ReleaseData, StoredObject } from "./types.ts";

export interface HandlerContext {
  storage: StorageProvider;
  release: ReleaseStore;
  adminHtml: () => Promise<string> | string;
  adminUsername: string;
  adminPassword: string;
  uploadAuthKey: string;
  port?: number;
  sampleBinaryGenerator?: (filename: string, sizeMb: number) => Promise<string | void> | string | void;
}

export function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS, HEAD",
    "Access-Control-Allow-Headers": "Content-Type, Range, Authorization, X-API-Key"
  };
}

export function jsonResponse(
  data: any,
  status: number = 200,
  extraHeaders: Record<string, string> = {}
): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...corsHeaders(),
      ...extraHeaders
    }
  });
}

export function getBaseUrl(req: Request, fallbackPort: number = 3001): string {
  const envUrl = (
    process.env.PUBLIC_URL ||
    process.env.UPDATE_SERVER_URL ||
    ""
  ).trim();
  if (envUrl) {
    return envUrl.replace(/\/+$/, "");
  }

  try {
    const parsed = new URL(req.url);
    if (parsed.protocol === "https:" || parsed.hostname.includes("workers.dev")) {
      return parsed.origin;
    }
    const forwardedHost = req.headers.get("x-forwarded-host");
    const forwardedProto = req.headers.get("x-forwarded-proto");
    if (forwardedHost) {
      const proto = forwardedProto || (parsed.protocol === "https:" ? "https" : "http");
      return `${proto}://${forwardedHost}`;
    }
    if (parsed.hostname && parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") {
      return parsed.origin;
    }
  } catch {}

  const host =
    req.headers.get("x-forwarded-host") ||
    req.headers.get("host") ||
    `localhost:${fallbackPort}`;
  const proto = req.headers.get("x-forwarded-proto") === "https" ? "https" : "http";
  return `${proto}://${host}`;
}

export function getDisposition(filename: string, contentType: string, url: URL): string {
  if (url.searchParams.has("download")) {
    return `attachment; filename="${filename}"`;
  }
  if (url.searchParams.has("inline") || url.searchParams.has("view")) {
    return `inline; filename="${filename}"`;
  }
  const ct = contentType.toLowerCase();
  if (
    ct.startsWith("image/") ||
    ct.startsWith("video/") ||
    ct.startsWith("audio/") ||
    ct.startsWith("text/") ||
    ct === "application/pdf"
  ) {
    return `inline; filename="${filename}"`;
  }
  return `attachment; filename="${filename}"`;
}

export function compareSemver(v1: string, v2: string): number {
  const parse = (v: string) =>
    v
      .replace(/^v/, "")
      .split(".")
      .map((n) => parseInt(n, 10) || 0);
  const p1 = parse(v1);
  const p2 = parse(v2);
  for (let i = 0; i < Math.max(p1.length, p2.length); i++) {
    const n1 = p1[i] || 0;
    const n2 = p2[i] || 0;
    if (n1 > n2) return 1;
    if (n1 < n2) return -1;
  }
  return 0;
}

export async function maybeAutoUpdateRelease(
  filename: string,
  fileInfo: StoredObject,
  searchParams: URLSearchParams,
  baseUrl: string,
  releaseStore: ReleaseStore
): Promise<ReleaseData | null> {
  const updateFlag = searchParams.get("update_release")?.toLowerCase();
  if (updateFlag !== "true" && updateFlag !== "1" && updateFlag !== "yes") {
    return null;
  }

  let platformParam = searchParams.get("platform")?.toLowerCase() || "";
  if (!platformParam) {
    if (filename.endsWith(".dmg") || filename.endsWith(".pkg") || filename.endsWith(".app")) {
      platformParam = "macos";
    } else if (filename.endsWith(".exe") || filename.endsWith(".msi")) {
      platformParam = "windows";
    } else if (
      filename.endsWith(".appimage") ||
      filename.endsWith(".deb") ||
      filename.endsWith(".rpm")
    ) {
      platformParam = "linux";
    }
  }

  if (platformParam !== "macos" && platformParam !== "windows" && platformParam !== "linux") {
    return null;
  }

  const data = await releaseStore.getRelease();

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

  await releaseStore.saveRelease(data);
  try {
    const history = await releaseStore.getHistory();
    const idx = history.findIndex((h) => h.version === data.version);
    if (idx !== -1) {
      history[idx] = { ...history[idx], ...data };
    } else {
      history.unshift(data);
    }
    await releaseStore.saveHistory(history);
  } catch (err) {
    console.warn("[RELEASE-HISTORY] Failed to sync auto-updated release to history:", err);
  }
  console.log(
    `[RELEASE] Automatically updated release metadata for ${platformParam} -> ${filename} (v${data.version})`
  );
  return data;
}

export async function handleUpdateRequest(
  req: Request,
  ctx: HandlerContext
): Promise<Response> {
  const url = new URL(req.url);
  const pathname = url.pathname;
  const method = req.method;
  const currentPort = ctx.port || 3001;
  const baseUrl = getBaseUrl(req, currentPort);

  const authCtx = {
    adminUsername: ctx.adminUsername,
    adminPassword: ctx.adminPassword,
    uploadAuthKey: ctx.uploadAuthKey
  };

  // CORS Preflight
  if (method === "OPTIONS") {
    return new Response(null, {
      status: 200,
      headers: corsHeaders()
    });
  }

  // HEAD requests
  if (method === "HEAD") {
    if (
      pathname.startsWith("/downloads/") ||
      (pathname.startsWith("/storage/") && pathname !== "/storage")
    ) {
      const prefix = pathname.startsWith("/downloads/") ? "/downloads/" : "/storage/";
      const filename = path.basename(decodeURIComponent(pathname.slice(prefix.length)).trim());
      const meta = await ctx.storage.headObject(filename);
      if (!meta) {
        return new Response(null, { status: 404, headers: corsHeaders() });
      }
      const cType = meta.content_type || guessContentType(filename);
      const etag = meta.etag || `"${meta.size_bytes}"`;
      return new Response(null, {
        status: 200,
        headers: {
          "Content-Type": cType,
          "Content-Length": String(meta.size_bytes),
          "Accept-Ranges": "bytes",
          ETag: etag,
          "Content-Disposition": getDisposition(filename, cType, url),
          ...corsHeaders()
        }
      });
    }

    if (pathname === "/" || pathname === "/admin" || pathname === "/index.html") {
      return new Response(null, {
        status: 200,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          ...corsHeaders()
        }
      });
    }

    return new Response(null, {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        ...corsHeaders()
      }
    });
  }

  // GET requests
  if (method === "GET") {
    // 0. Health check
    if (pathname === "/health") {
      const stats = await ctx.storage.getStats();
      return jsonResponse({
        status: "ok",
        service: "metdesk-update-server",
        version: "2.3.0",
        storage: ctx.storage.storageName,
        stats,
        auth_required: Boolean(ctx.adminPassword || ctx.uploadAuthKey),
        timestamp: Math.floor(Date.now() / 1000)
      });
    }

    // 0.1 Check auth status for Web Admin UI
    if (pathname === "/api/auth/status") {
      const isAuthed = isRequestAuthenticated(req, authCtx);
      let currentUser: string | null = null;
      const secret = ctx.adminPassword || ctx.uploadAuthKey || "metdesk-default-secret-salt";

      if (isAuthed) {
        const cookieHeader = req.headers.get("Cookie") || "";
        for (const part of cookieHeader.split(";")) {
          const trimmed = part.trim();
          if (trimmed.startsWith("session=")) {
            const token = trimmed.slice("session=".length).trim();
            const verified = verifySessionToken(token, secret);
            if (verified.valid && verified.username) {
              currentUser = verified.username;
              break;
            }
          }
        }
        if (!currentUser) {
          currentUser = ctx.adminUsername || "admin";
        }
      }

      return jsonResponse({
        authenticated: isAuthed,
        is_authenticated: isAuthed,
        username: currentUser,
        auth_required: Boolean(ctx.adminPassword || ctx.uploadAuthKey)
      });
    }

    // 1. Release metadata
    if (
      pathname === "/updates" ||
      pathname === "/api/updates" ||
      pathname === "/api/updates/latest"
    ) {
      const releaseData = await ctx.release.getRelease();
      const rawParam = url.searchParams.get("raw");
      const checkParam = url.searchParams.get("check");
      const clientVersion = url.searchParams.get("current_version") || url.searchParams.get("version");
      const clientPlatform = url.searchParams.get("platform");

      if (rawParam === "true") {
        return jsonResponse(releaseData);
      }

      const data: ReleaseData = {
        ...releaseData,
        downloads: { ...(releaseData.downloads || {}) }
      };

      for (const platform of ["macos", "windows", "linux"] as const) {
        const dl = data.downloads[platform];
        if (dl) {
          const filename = dl.filename || path.basename(dl.url || "");
          const meta = await ctx.storage.headObject(filename);
          if (meta) {
            data.downloads[platform] = {
              ...dl,
              url: `${baseUrl}/storage/${filename}`,
              size: Math.floor(meta.size_bytes / 1024),
              sizeBytes: meta.size_bytes,
              sizeUnit: "KB",
              sha256: meta.sha256 || dl.sha256 || ""
            };
          } else {
            data.downloads[platform] = {
              ...dl,
              url: `${baseUrl}/storage/${filename}`
            };
          }
        }
      }

      if (checkParam === "true" && clientVersion) {
        const hasUpdate = compareSemver(data.version, clientVersion) > 0;
        let platformDownload = undefined;
        if (clientPlatform) {
          const cp = clientPlatform.toLowerCase();
          const normPlat = cp.includes("win") ? "windows" : cp.includes("linux") ? "linux" : "macos";
          platformDownload = data.downloads[normPlat];
        }

        return jsonResponse({
          update_available: hasUpdate,
          current_version: clientVersion,
          latest_version: data.version,
          release_type: data.type || "minor",
          summary: data.summary || "",
          release_date: data.releaseDate || "",
          changelog: data.changelog || [],
          download: platformDownload,
          all_downloads: data.downloads,
          force_update: Boolean(data.forceUpdate)
        });
      }

      return jsonResponse(data);
    }

    // 1.1 Direct release.json file
    if (pathname === "/release.json") {
      const data = await ctx.release.getRelease();
      return jsonResponse(data);
    }

    // 1.2 Draft release endpoint
    if (pathname === "/api/release/draft" || pathname === "/api/updates/draft") {
      const draft = await ctx.release.getDraft();
      return jsonResponse({ success: true, draft });
    }

    // 1.3 History / Changelog endpoint
    if (
      pathname === "/api/release/history" ||
      pathname === "/api/updates/history" ||
      pathname === "/api/changelog"
    ) {
      const history = await ctx.release.getHistory();
      const current = await ctx.release.getRelease();
      return jsonResponse({
        success: true,
        history,
        active_version: current.version
      });
    }

    // 2. Binary object download with HTTP Range support
    if (
      pathname.startsWith("/downloads/") ||
      (pathname.startsWith("/storage/") && pathname !== "/storage")
    ) {
      const prefix = pathname.startsWith("/downloads/") ? "/downloads/" : "/storage/";
      const filename = path.basename(decodeURIComponent(pathname.slice(prefix.length)).trim());
      const rangeHeader = req.headers.get("Range");

      const downloadResult = await ctx.storage.downloadObject(filename, rangeHeader);

      if (!downloadResult) {
        return new Response(`Binary object '${filename}' not found in storage.`, {
          status: 404,
          headers: { "Content-Type": "text/plain", ...corsHeaders() }
        });
      }

      if ("status" in downloadResult && downloadResult.status === 416) {
        return new Response(null, {
          status: 416,
          headers: {
            "Content-Range": `bytes */${downloadResult.totalSize}`,
            ...corsHeaders()
          }
        });
      }

      const res = downloadResult as {
        stream: any;
        size: number;
        contentType: string;
        etag: string;
        range?: { start: number; end: number; total: number };
      };

      const disposition = getDisposition(filename, res.contentType, url);

      if (res.range) {
        return new Response(res.stream, {
          status: 206,
          headers: {
            "Content-Type": res.contentType,
            "Content-Range": `bytes ${res.range.start}-${res.range.end}/${res.range.total}`,
            "Content-Length": String(res.size),
            "Accept-Ranges": "bytes",
            ETag: res.etag,
            "Content-Disposition": disposition,
            ...corsHeaders()
          }
        });
      }

      return new Response(res.stream, {
        status: 200,
        headers: {
          "Content-Type": res.contentType,
          "Content-Length": String(res.size),
          "Accept-Ranges": "bytes",
          ETag: res.etag,
          "Content-Disposition": disposition,
          ...corsHeaders()
        }
      });
    }

    // 3. Storage objects listing
    if (
      pathname === "/storage" ||
      pathname === "/api/storage" ||
      pathname === "/api/binaries"
    ) {
      const rawObjects = await ctx.storage.listObjects(baseUrl);
      const stats = await ctx.storage.getStats();
      const currentRelease = await ctx.release.getRelease();

      const activeMac = currentRelease.downloads?.macos?.filename || "";
      const activeWin = currentRelease.downloads?.windows?.filename || "";
      const activeLinux = currentRelease.downloads?.linux?.filename || "";

      const objects = rawObjects.map((obj) => {
        const isMacActive = Boolean(activeMac && obj.name === activeMac);
        const isWinActive = Boolean(activeWin && obj.name === activeWin);
        const isLinuxActive = Boolean(activeLinux && obj.name === activeLinux);
        const activeBadges: string[] = [];
        if (isMacActive) activeBadges.push("macOS");
        if (isWinActive) activeBadges.push("Windows");
        if (isLinuxActive) activeBadges.push("Linux");
        const activeBadge = activeBadges.length > 0 ? activeBadges.join(" & ") : null;

        return {
          ...obj,
          download_url: `${baseUrl}/storage/${obj.name}`,
          is_active_macos: isMacActive,
          is_active_windows: isWinActive,
          is_active_linux: isLinuxActive,
          active_release: activeBadge
        };
      });

      return jsonResponse({
        success: true,
        stats,
        count: objects.length,
        active_release: {
          version: currentRelease.version,
          macos_binary: activeMac || null,
          windows_binary: activeWin || null,
          linux_binary: activeLinux || null
        },
        objects
      });
    }

    // 4. Mock endpoints
    if (pathname === "/license") {
      return jsonResponse({
        valid: true,
        license_key: "METDESK-HYBRID-DEMO-2026",
        expires: "2099-12-31"
      });
    }

    if (pathname === "/quota") {
      return jsonResponse({
        balance: 150,
        currency: "DOCS",
        unlimited: false
      });
    }

    // 5. Web Admin Dashboard HTML
    if (pathname === "/" || pathname === "/admin" || pathname === "/index.html") {
      try {
        const html = await ctx.adminHtml();
        return new Response(html, {
          status: 200,
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            ...corsHeaders()
          }
        });
      } catch (err) {
        return new Response("Admin Dashboard not found", {
          status: 404,
          headers: { "Content-Type": "text/plain", ...corsHeaders() }
        });
      }
    }

    return new Response("Not found", {
      status: 404,
      headers: { "Content-Type": "text/plain", ...corsHeaders() }
    });
  }

  // POST requests
  if (method === "POST") {
    // 1. Login
    if (pathname === "/api/login") {
      try {
        const body = await req.json();
        const username = (body.username || "").trim();
        const password = (body.password || "").trim();

        const configuredPassword = ctx.adminPassword;
        const configuredUsername = ctx.adminUsername || "admin";

        if (
          !configuredPassword ||
          (username === configuredUsername && password === configuredPassword)
        ) {
          const secret = configuredPassword || ctx.uploadAuthKey || "metdesk-default-secret-salt";
          const sessionToken = createSessionToken(username || configuredUsername, secret);

          return jsonResponse(
            {
              success: true,
              message: "Login berhasil.",
              token: sessionToken,
              username: username || configuredUsername
            },
            200,
            {
              "Set-Cookie": `session=${sessionToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`
            }
          );
        }

        return jsonResponse(
          { success: false, error: "Username atau password salah." },
          401
        );
      } catch (err) {
        return jsonResponse(
          { success: false, error: "Invalid JSON payload." },
          400
        );
      }
    }

    // 2. Logout
    if (pathname === "/api/logout") {
      const cookieHeader = req.headers.get("Cookie") || "";
      for (const part of cookieHeader.split(";")) {
        const trimmed = part.trim();
        if (trimmed.startsWith("session=")) {
          const token = trimmed.slice("session=".length).trim();
          ACTIVE_SESSIONS.delete(token);
        }
      }

      return jsonResponse(
        { success: true, message: "Logout berhasil." },
        200,
        {
          "Set-Cookie": "session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"
        }
      );
    }

    // Authentication check for administrative POST routes
    if (!isRequestAuthenticated(req, authCtx)) {
      return jsonResponse(
        { success: false, error: "Unauthorized. Silakan login atau sertakan API key." },
        401
      );
    }

    // 3. Update release metadata
    if (pathname === "/api/updates" || pathname === "/updates") {
      try {
        const body = await req.json();
        const currentData = await ctx.release.getRelease();
        const merged: ReleaseData = {
          ...currentData,
          ...body,
          downloads: {
            ...(currentData.downloads || {}),
            ...(body.downloads || {})
          }
        };

        await ctx.release.saveRelease(merged);
        console.log(`[RELEASE] Updated release metadata: v${merged.version}`);
        return jsonResponse({
          success: true,
          message: "Release metadata updated successfully.",
          data: merged
        });
      } catch (err) {
        return jsonResponse({ success: false, error: String(err) }, 400);
      }
    }

    // 3.1 Save release draft
    if (pathname === "/api/release/draft" || pathname === "/api/updates/draft") {
      if (!isRequestAuthenticated(req, authCtx)) {
        return jsonResponse(
          { success: false, error: "Unauthorized. Silakan login terlebih dahulu." },
          401
        );
      }
      try {
        const body = await req.json();
        await ctx.release.saveDraft(body);
        return jsonResponse({
          success: true,
          message: `Draft rilis v${body.version || ""} berhasil disimpan.`,
          draft: body
        });
      } catch (err) {
        return jsonResponse({ success: false, error: String(err) }, 400);
      }
    }

    // 3.2 Publish release (makes it active on /updates and records to changelog history)
    if (pathname === "/api/release/publish" || pathname === "/api/updates/publish") {
      if (!isRequestAuthenticated(req, authCtx)) {
        return jsonResponse(
          { success: false, error: "Unauthorized. Silakan login terlebih dahulu." },
          401
        );
      }
      try {
        const body = await req.json();
        const version = (body.version || "").trim();
        if (!version) {
          return jsonResponse(
            { success: false, error: "Nomor versi rilis wajib diisi." },
            400
          );
        }

        const currentData = await ctx.release.getRelease();
        const published: ReleaseData = {
          ...currentData,
          ...body,
          version,
          releaseDate: body.releaseDate || formatReleaseDate(),
          downloads: {
            ...(currentData.downloads || {}),
            ...(body.downloads || {})
          }
        };

        // Enrich platform downloads with storage metadata (size, sha256)
        for (const platform of ["macos", "windows", "linux"] as const) {
          const dl = published.downloads[platform];
          if (dl && dl.filename) {
            const meta = await ctx.storage.headObject(dl.filename);
            if (meta) {
              published.downloads[platform] = {
                ...dl,
                url: `${baseUrl}/storage/${dl.filename}`,
                size: Math.floor(meta.size_bytes / 1024),
                sizeBytes: meta.size_bytes,
                sizeUnit: "KB",
                sha256: meta.sha256 || dl.sha256 || ""
              };
            }
          }
        }

        await ctx.release.saveRelease(published);

        // Record to Changelog History
        try {
          const history = await ctx.release.getHistory();
          const idx = history.findIndex((h) => h.version === published.version);
          if (idx !== -1) {
            history[idx] = { ...history[idx], ...published };
          } else {
            history.unshift(published);
          }
          await ctx.release.saveHistory(history);
          await ctx.release.clearDraft();
        } catch (histErr) {
          console.warn("[PUBLISH] History sync warning:", histErr);
        }

        console.log(`[RELEASE] Published release v${published.version}`);
        return jsonResponse({
          success: true,
          message: `Rilis v${published.version} berhasil dipublikasikan (live)!`,
          release: published,
          data: published
        });
      } catch (err: any) {
        return jsonResponse({ success: false, error: err.message || String(err) }, 400);
      }
    }

    // 3.3 Rollback / Switch active release from changelog history
    if (
      pathname === "/api/release/rollback" ||
      pathname === "/api/release/switch-active" ||
      pathname === "/api/updates/rollback"
    ) {
      if (!isRequestAuthenticated(req, authCtx)) {
        return jsonResponse(
          { success: false, error: "Unauthorized. Silakan login terlebih dahulu." },
          401
        );
      }
      try {
        const body = await req.json();
        const targetVersion = (body.version || "").trim();
        if (!targetVersion) {
          return jsonResponse(
            { success: false, error: "Versi target wajib ditentukan." },
            400
          );
        }

        const history = await ctx.release.getHistory();
        const target = history.find((h) => h.version === targetVersion);
        if (!target) {
          return jsonResponse(
            { success: false, error: `Versi ${targetVersion} tidak ditemukan di riwayat changelog.` },
            404
          );
        }

        await ctx.release.saveRelease(target);
        console.log(`[RELEASE] Switched active release to v${target.version}`);
        return jsonResponse({
          success: true,
          message: `Berhasil beralih ke rilis v${target.version} (kini aktif di /updates).`,
          release: target,
          data: target
        });
      } catch (err: any) {
        return jsonResponse({ success: false, error: err.message || String(err) }, 400);
      }
    }

    // 3.4 Update or add history / changelog items
    if (pathname === "/api/release/history" || pathname === "/api/updates/history") {
      if (!isRequestAuthenticated(req, authCtx)) {
        return jsonResponse(
          { success: false, error: "Unauthorized. Silakan login terlebih dahulu." },
          401
        );
      }
      try {
        const body = await req.json();
        let newHistory: ReleaseData[] = [];
        if (Array.isArray(body)) {
          newHistory = body;
        } else if (Array.isArray(body.history)) {
          newHistory = body.history;
        } else if (body.version) {
          const currentHistory = await ctx.release.getHistory();
          const idx = currentHistory.findIndex((h) => h.version === body.version);
          if (idx !== -1) {
            currentHistory[idx] = { ...currentHistory[idx], ...body };
          } else {
            currentHistory.unshift(body);
          }
          newHistory = currentHistory;
        }
        await ctx.release.saveHistory(newHistory);
        return jsonResponse({
          success: true,
          message: "Riwayat changelog berhasil diperbarui.",
          history: newHistory
        });
      } catch (err: any) {
        return jsonResponse({ success: false, error: err.message || String(err) }, 400);
      }
    }

    // 4. Rename binary
    if (pathname === "/api/storage/rename" || pathname === "/storage/rename") {
      try {
        const body = await req.json();
        const oldName = (body.old_name || body.oldName || "").trim();
        const newName = (body.new_name || body.newName || "").trim();

        if (!oldName || !newName) {
          return jsonResponse(
            { success: false, error: "Parameter old_name dan new_name wajib diisi." },
            400
          );
        }

        if (!isAllowedBinaryFilename(newName)) {
          return jsonResponse(
            { success: false, error: getAllowedExtensionsErrorMessage() },
            400
          );
        }

        const renamed = await ctx.storage.renameObject(oldName, newName);
        if (!renamed) {
          return jsonResponse(
            { success: false, error: `File '${oldName}' tidak ditemukan di storage.` },
            404
          );
        }

        // Auto update release.json if requested
        let releaseData: ReleaseData | null = null;
        if (body.update_release === true || body.update_release === "true") {
          const current = await ctx.release.getRelease();
          let changed = false;
          if (current.downloads) {
            for (const platform of ["macos", "windows", "linux"] as const) {
              const dl = current.downloads[platform];
              if (dl && dl.filename === oldName) {
                current.downloads[platform] = {
                  ...dl,
                  filename: newName,
                  url: `${baseUrl}/storage/${newName}`,
                  sha256: renamed.sha256 || dl.sha256
                };
                changed = true;
              }
            }
          }
          if (changed) {
            await ctx.release.saveRelease(current);
            releaseData = current;
          }
        }

        return jsonResponse({
          success: true,
          message: `File berhasil diubah namanya menjadi '${newName}'.`,
          object: renamed,
          data: releaseData || (await ctx.release.getRelease())
        });
      } catch (err: any) {
        if (err.code === "EEXIST" || String(err).includes("sudah ada")) {
          return jsonResponse({ success: false, error: err.message }, 409);
        }
        return jsonResponse({ success: false, error: err.message || String(err) }, 500);
      }
    }

    // 5. Set active binary
    if (pathname === "/api/storage/set-active" || pathname === "/storage/set-active") {
      try {
        const body = await req.json();
        const platform = (body.platform || "").toLowerCase().trim();
        const filename = path.basename((body.filename || "").trim());

        if (!["macos", "windows", "linux"].includes(platform)) {
          return jsonResponse(
            { success: false, error: "Platform harus berupa 'macos', 'windows', atau 'linux'." },
            400
          );
        }

        const meta = await ctx.storage.headObject(filename);
        if (!meta) {
          return jsonResponse(
            { success: false, error: `File '${filename}' tidak ditemukan di storage.` },
            404
          );
        }

        const current = await ctx.release.getRelease();
        if (!current.downloads) {
          current.downloads = {};
        }

        if (body.version && typeof body.version === "string") {
          current.version = body.version.trim();
        } else {
          const verMatch = filename.match(/(\d+\.\d+\.\d+)/);
          if (verMatch) {
            current.version = verMatch[1];
          }
        }

        current.downloads[platform] = {
          filename,
          url: `${baseUrl}/storage/${filename}`,
          size: Math.floor(meta.size_bytes / 1024),
          sizeBytes: meta.size_bytes,
          sizeUnit: "KB",
          sha256: meta.sha256 || ""
        };
        current.releaseDate = formatReleaseDate();

        await ctx.release.saveRelease(current);

        return jsonResponse({
          success: true,
          message: `Binary ${filename} berhasil dijadikan rilis aktif untuk ${platform}.`,
          release: current,
          data: current
        });
      } catch (err: any) {
        return jsonResponse({ success: false, error: err.message || String(err) }, 500);
      }
    }

    // 6. Bulk delete
    if (pathname === "/api/storage/bulk-delete" || pathname === "/storage/bulk-delete") {
      try {
        const body = await req.json();
        const filenames: string[] = body.filenames || body.files || [];

        if (!Array.isArray(filenames) || filenames.length === 0) {
          return jsonResponse(
            { success: false, error: "Daftar file tidak boleh kosong." },
            400
          );
        }

        const deleted: string[] = [];
        const failed: string[] = [];

        for (const rawName of filenames) {
          const clean = path.basename(String(rawName).trim());
          if (!clean) continue;
          const ok = await ctx.storage.deleteObject(clean);
          if (ok) {
            deleted.push(clean);
          } else {
            failed.push(clean);
          }
        }

        return jsonResponse({
          success: true,
          message: `${deleted.length} file berhasil dihapus.`,
          deleted,
          failed
        });
      } catch (err: any) {
        return jsonResponse({ success: false, error: err.message || String(err) }, 500);
      }
    }

    // 7. Sample binary generation
    if (pathname === "/api/generate-binary") {
      try {
        const body = await req.json();
        const filename = path.basename((body.filename || "METDesk-sample.exe").trim());
        const sizeMb = typeof body.size_mb === "number" ? body.size_mb : 1;

        if (!isAllowedBinaryFilename(filename)) {
          return jsonResponse(
            { success: false, error: getAllowedExtensionsErrorMessage() },
            400
          );
        }

        if (ctx.sampleBinaryGenerator) {
          await ctx.sampleBinaryGenerator(filename, sizeMb);
        } else {
          // Platform-agnostic dummy binary generation (e.g. Workers)
          const totalBytes = sizeMb * 1024 * 1024;
          const stub = new Uint8Array(totalBytes);
          if (filename.endsWith(".exe")) {
            const peHeader = Buffer.from("MZ\x90\x00\x03\x00\x00\x00\x04\x00\x00\x00\xff\xff\x00\x00");
            stub.set(peHeader, 0);
          } else if (filename.endsWith(".dmg")) {
            const kolyHeader = Buffer.from("koly\x00\x00\x00\x04\x00\x00\x02\x00\x00\x00\x00\x00");
            stub.set(kolyHeader, 0);
          }
          await ctx.storage.putObject(filename, stub, totalBytes);
        }

        const meta = await ctx.storage.headObject(filename);
        return jsonResponse({
          success: true,
          message: `Sample binary '${filename}' (${sizeMb} MB) successfully generated.`,
          filename,
          object: meta
        });
      } catch (err: any) {
        return jsonResponse({ success: false, error: err.message || String(err) }, 500);
      }
    }

    // 8. Upload binary via POST (Multipart or Raw)
    if (
      pathname === "/storage" ||
      pathname === "/api/storage" ||
      pathname === "/api/upload"
    ) {
      const cType = req.headers.get("content-type") || "";

      // Case A: Multipart Form Data
      if (cType.includes("multipart/form-data")) {
        try {
          const formData = await req.formData();
          const fileEntry = formData.get("file");

          if (!fileEntry || !(fileEntry instanceof Blob)) {
            return jsonResponse(
              { success: false, error: "Form field 'file' tidak ditemukan atau bukan file valid." },
              400
            );
          }

          const filename = path.basename((fileEntry.name || "binary.bin").trim());
          if (!isAllowedBinaryFilename(filename)) {
            return jsonResponse(
              { success: false, error: getAllowedExtensionsErrorMessage() },
              400
            );
          }
          const stream = fileEntry.stream();
          const saved = await ctx.storage.putObject(filename, stream, fileEntry.size, fileEntry.type);

          const updatedRelease = await maybeAutoUpdateRelease(
            filename,
            saved,
            url.searchParams,
            baseUrl,
            ctx.release
          );

          return jsonResponse({
            success: true,
            message: `Object ${filename} successfully saved to storage`,
            object: {
              ...saved,
              url: `${baseUrl}/storage/${saved.key}`,
              release_updated: Boolean(updatedRelease)
            },
            release: updatedRelease
          });
        } catch (err: any) {
          return jsonResponse({ success: false, error: err.message || String(err) }, 500);
        }
      }

      // Case B: Direct Binary Stream via POST
      let filename = url.searchParams.get("filename") || req.headers.get("x-filename");
      if (!filename) {
        return jsonResponse(
          { success: false, error: "Query parameter 'filename' atau header 'X-Filename' diperlukan untuk direct upload." },
          400
        );
      }

      filename = path.basename(filename.trim());
      if (!isAllowedBinaryFilename(filename)) {
        return jsonResponse(
          { success: false, error: getAllowedExtensionsErrorMessage() },
          400
        );
      }
      if (!req.body) {
        return jsonResponse({ success: false, error: "Request body kosong." }, 400);
      }

      try {
        const contentLength = req.headers.get("content-length")
          ? parseInt(req.headers.get("content-length")!, 10)
          : undefined;

        const saved = await ctx.storage.putObject(filename, req.body, contentLength, cType);
        const updatedRelease = await maybeAutoUpdateRelease(
          filename,
          saved,
          url.searchParams,
          baseUrl,
          ctx.release
        );

        return jsonResponse({
          success: true,
          message: `Object ${filename} successfully saved to storage`,
          object: {
            ...saved,
            url: `${baseUrl}/storage/${saved.key}`,
            release_updated: Boolean(updatedRelease)
          },
          release: updatedRelease
        });
      } catch (err: any) {
        return jsonResponse({ success: false, error: err.message || String(err) }, 500);
      }
    }

    return new Response("Not found", {
      status: 404,
      headers: { "Content-Type": "text/plain", ...corsHeaders() }
    });
  }

  // PUT requests: Streaming object upload
  if (method === "PUT") {
    if (pathname.startsWith("/storage/") || pathname.startsWith("/api/upload/")) {
      const prefix = pathname.startsWith("/storage/") ? "/storage/" : "/api/upload/";
      const filename = path.basename(decodeURIComponent(pathname.slice(prefix.length)).trim());

      if (!filename) {
        return jsonResponse(
          { success: false, error: "Filename tidak boleh kosong di URL path." },
          400
        );
      }

      if (!isAllowedBinaryFilename(filename)) {
        return jsonResponse(
          { success: false, error: getAllowedExtensionsErrorMessage() },
          400
        );
      }

      if (!isRequestAuthenticated(req, authCtx)) {
        return jsonResponse(
          { success: false, error: "Unauthorized. Silakan gunakan X-API-Key atau header Authorization." },
          401
        );
      }

      if (!req.body) {
        return jsonResponse({ success: false, error: "Request body stream kosong." }, 400);
      }

      try {
        const contentLength = req.headers.get("content-length")
          ? parseInt(req.headers.get("content-length")!, 10)
          : undefined;
        const contentType = req.headers.get("content-type") || undefined;

        const saved = await ctx.storage.putObject(
          filename,
          req.body,
          contentLength,
          contentType
        );

        const updatedRelease = await maybeAutoUpdateRelease(
          filename,
          saved,
          url.searchParams,
          baseUrl,
          ctx.release
        );

        return jsonResponse({
          success: true,
          message: `Object ${filename} successfully saved to storage`,
          object: {
            ...saved,
            url: `${baseUrl}/storage/${saved.key}`,
            release_updated: Boolean(updatedRelease)
          },
          release: updatedRelease
        });
      } catch (err: any) {
        return jsonResponse({ success: false, error: err.message || String(err) }, 500);
      }
    }

    return new Response("Endpoint not found", {
      status: 404,
      headers: { "Content-Type": "text/plain", ...corsHeaders() }
    });
  }

  // DELETE requests
  if (method === "DELETE") {
    // Delete release draft
    if (pathname === "/api/release/draft" || pathname === "/api/updates/draft") {
      if (!isRequestAuthenticated(req, authCtx)) {
        return jsonResponse(
          { success: false, error: "Unauthorized. Silakan login atau sertakan API key." },
          401
        );
      }
      try {
        await ctx.release.clearDraft();
        return jsonResponse({ success: true, message: "Draft berhasil dihapus." });
      } catch (err: any) {
        return jsonResponse({ success: false, error: err.message || String(err) }, 500);
      }
    }

    for (const prefix of ["/storage/", "/api/storage/", "/api/binaries/"]) {
      if (pathname.startsWith(prefix)) {
        if (!isRequestAuthenticated(req, authCtx)) {
          return jsonResponse(
            { success: false, error: "Unauthorized. Silakan login atau sertakan API key." },
            401
          );
        }

        const filename = path.basename(decodeURIComponent(pathname.slice(prefix.length)).trim());
        const deleted = await ctx.storage.deleteObject(filename);
        if (deleted) {
          return jsonResponse({ success: true, message: `Deleted object ${filename}` });
        } else {
          return jsonResponse(
            { success: false, error: `Object ${filename} not found.` },
            404
          );
        }
      }
    }

    return new Response("Not found", {
      status: 404,
      headers: { "Content-Type": "text/plain", ...corsHeaders() }
    });
  }

  return new Response("Method not allowed", {
    status: 405,
    headers: { "Content-Type": "text/plain", ...corsHeaders() }
  });
}
