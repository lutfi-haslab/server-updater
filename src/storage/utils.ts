/**
 * Storage and MIME Utility Functions.
 * 100% Platform Agnostic (Works in Bun, Node, and Cloudflare Workers).
 */

export function formatModifiedTime(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const Y = date.getFullYear();
  const M = pad(date.getMonth() + 1);
  const D = pad(date.getDate());
  const h = pad(date.getHours());
  const m = pad(date.getMinutes());
  const s = pad(date.getSeconds());
  return `${Y}-${M}-${D} ${h}:${m}:${s}`;
}

export function formatSize(bytesVal: number): string {
  if (bytesVal >= 1024 * 1024 * 1024) {
    return `${(bytesVal / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }
  if (bytesVal >= 1024 * 1024) {
    return `${(bytesVal / (1024 * 1024)).toFixed(2)} MB`;
  }
  if (bytesVal >= 1024) {
    return `${(bytesVal / 1024).toFixed(1)} KB`;
  }
  return `${bytesVal} B`;
}

// Allowed binary & installer extensions for desktop app distribution
export const ALLOWED_BINARY_EXTENSIONS = [
  // Windows
  ".exe",
  ".msi",
  // macOS
  ".dmg",
  ".pkg",
  ".app",
  // Linux
  ".appimage",
  ".deb",
  ".rpm",
  // Archives often used for binary packages
  ".zip",
  ".tar.gz",
  ".tgz",
  ".tar.xz"
] as const;

export function isAllowedBinaryFilename(filename: string): boolean {
  const lower = filename.toLowerCase();
  return ALLOWED_BINARY_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

export function getAllowedExtensionsErrorMessage(): string {
  return "Hanya file installer dan binary desktop yang diizinkan (.exe, .msi, .dmg, .pkg, .app, .AppImage, .deb, .rpm, .zip, .tar.gz).";
}

export function guessContentType(filename: string): string {
  const fn = filename.toLowerCase();

  // Desktop App Installers & Binaries
  if (fn.endsWith(".dmg")) return "application/x-apple-diskimage";
  if (fn.endsWith(".exe")) return "application/vnd.microsoft.portable-executable";
  if (fn.endsWith(".msi")) return "application/x-msi";
  if (fn.endsWith(".zip")) return "application/zip";
  if (fn.endsWith(".pkg")) return "application/x-newton-compatible-pkg";
  if (fn.endsWith(".appimage")) return "application/x-executable";
  if (fn.endsWith(".deb")) return "application/vnd.debian.binary-package";
  if (fn.endsWith(".rpm")) return "application/x-rpm";
  if (fn.endsWith(".tar.gz") || fn.endsWith(".tgz")) return "application/gzip";
  if (fn.endsWith(".tar.xz")) return "application/x-xz";
  if (fn.endsWith(".tar")) return "application/x-tar";
  if (fn.endsWith(".json")) return "application/json";

  // Images
  if (fn.endsWith(".jpg") || fn.endsWith(".jpeg")) return "image/jpeg";
  if (fn.endsWith(".png")) return "image/png";
  if (fn.endsWith(".webp")) return "image/webp";
  if (fn.endsWith(".gif")) return "image/gif";
  if (fn.endsWith(".svg")) return "image/svg+xml";
  if (fn.endsWith(".ico")) return "image/x-icon";
  if (fn.endsWith(".bmp")) return "image/bmp";

  // Documents & Media
  if (fn.endsWith(".pdf")) return "application/pdf";
  if (fn.endsWith(".txt")) return "text/plain; charset=utf-8";
  if (fn.endsWith(".html") || fn.endsWith(".htm")) return "text/html; charset=utf-8";
  if (fn.endsWith(".css")) return "text/css; charset=utf-8";
  if (fn.endsWith(".js") || fn.endsWith(".mjs")) return "application/javascript";
  if (fn.endsWith(".mp4")) return "video/mp4";
  if (fn.endsWith(".mp3")) return "audio/mpeg";

  return "application/octet-stream";
}
