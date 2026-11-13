/**
 * Local Disk Object Storage Provider for METDesk Update Server.
 * Used for Docker (Production) and local Bun development.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { StorageStats, StoredObject } from "../types.ts";
import type { DownloadResult, StorageProvider } from "./types.ts";
import { formatModifiedTime, formatSize, guessContentType } from "./utils.ts";

export { formatModifiedTime, formatSize, guessContentType };

const baseDir = (typeof import.meta !== "undefined" && (import.meta as any).dir) || process.cwd();
export const DEFAULT_STORAGE_DIR = path.resolve(baseDir, "../../binaries");

export function getUploadAuthKey(): string {
  return (process.env.UPLOAD_AUTH_KEY || "").trim();
}

export function getConfiguredStorageDir(): string {
  const envDir = (
    process.env.STORAGE_DIR ||
    process.env.STORAGE_PATH ||
    process.env.BINARIES_DIR ||
    ""
  ).trim();
  return envDir ? path.resolve(envDir) : DEFAULT_STORAGE_DIR;
}

export class LocalStorageProvider implements StorageProvider {
  public readonly storageName = "built-in-object-storage";
  public readonly storageDir: string;
  private _hashCache: Map<string, string> = new Map();

  constructor(storageDir?: string) {
    this.storageDir = storageDir ? path.resolve(storageDir) : getConfiguredStorageDir();
    fs.mkdirSync(this.storageDir, { recursive: true });
    console.log(`[STORAGE] Local Object Storage ACTIVE (Directory: ${this.storageDir})`);
  }

  isAuthValid(authHeader?: string | null, apiKeyHeader?: string | null): boolean {
    const uploadAuthKey = getUploadAuthKey();
    if (!uploadAuthKey) {
      return true;
    }

    let providedKey: string | null = null;
    if (apiKeyHeader) {
      providedKey = apiKeyHeader.trim();
    } else if (authHeader) {
      const trimmed = authHeader.trim();
      if (trimmed.toLowerCase().startsWith("bearer ")) {
        providedKey = trimmed.slice(7).trim();
      } else {
        providedKey = trimmed;
      }
    }

    return providedKey === uploadAuthKey;
  }

  async putObject(
    key: string,
    stream:
      | ReadableStream<Uint8Array>
      | AsyncIterable<Uint8Array>
      | Uint8Array
      | Buffer
      | NodeJS.ReadableStream,
    sizeBytes?: number,
    contentType?: string
  ): Promise<StoredObject> {
    const cleanKey = path.basename(key);
    const targetPath = path.join(this.storageDir, cleanKey);
    const tempPath = path.join(this.storageDir, `.tmp_${Date.now()}_${cleanKey}`);

    const hasher = createHash("sha256");
    let totalWritten = 0;

    try {
      const fileWriter = Bun.file(tempPath).writer();

      if (stream instanceof Uint8Array || Buffer.isBuffer(stream)) {
        let chunk: Uint8Array = stream;
        if (sizeBytes !== undefined && chunk.length > sizeBytes) {
          chunk = chunk.subarray(0, sizeBytes);
        }
        hasher.update(chunk);
        fileWriter.write(chunk);
        totalWritten = chunk.length;
      } else if (stream && typeof (stream as any)[Symbol.asyncIterator] === "function") {
        for await (const chunk of stream as AsyncIterable<Uint8Array>) {
          let slice = chunk;
          if (sizeBytes !== undefined && totalWritten + slice.length > sizeBytes) {
            slice = slice.subarray(0, sizeBytes - totalWritten);
          }
          if (slice.length === 0) break;
          hasher.update(slice);
          fileWriter.write(slice);
          totalWritten += slice.length;
          if (sizeBytes !== undefined && totalWritten >= sizeBytes) {
            break;
          }
        }
      } else if (stream && typeof (stream as any).getReader === "function") {
        const reader = (stream as ReadableStream<Uint8Array>).getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done || !value) break;
          let slice = value;
          if (sizeBytes !== undefined && totalWritten + slice.length > sizeBytes) {
            slice = slice.subarray(0, sizeBytes - totalWritten);
          }
          if (slice.length === 0) break;
          hasher.update(slice);
          fileWriter.write(slice);
          totalWritten += slice.length;
          if (sizeBytes !== undefined && totalWritten >= sizeBytes) {
            break;
          }
        }
      } else if (stream && typeof (stream as any).read === "function") {
        for await (const chunk of stream as AsyncIterable<any>) {
          const u8 = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          let slice = u8;
          if (sizeBytes !== undefined && totalWritten + slice.length > sizeBytes) {
            slice = slice.subarray(0, sizeBytes - totalWritten);
          }
          if (slice.length === 0) break;
          hasher.update(slice);
          fileWriter.write(slice);
          totalWritten += slice.length;
          if (sizeBytes !== undefined && totalWritten >= sizeBytes) {
            break;
          }
        }
      } else {
        throw new Error("Unsupported stream type for putObject");
      }

      await fileWriter.end();

      if (fs.existsSync(targetPath)) {
        fs.unlinkSync(targetPath);
      }
      fs.renameSync(tempPath, targetPath);
    } catch (err) {
      if (fs.existsSync(tempPath)) {
        try {
          fs.unlinkSync(tempPath);
        } catch {}
      }
      throw err;
    }

    const finalContentType = contentType || LocalStorageProvider.guessContentType(cleanKey);
    const digest = hasher.digest("hex");

    console.log(
      `[STORAGE] Stored object: ${cleanKey} (${LocalStorageProvider.formatSize(totalWritten)}, sha256=${digest.slice(0, 12)}...)`
    );

    return {
      key: cleanKey,
      name: cleanKey,
      filename: cleanKey,
      size_bytes: totalWritten,
      size_formatted: LocalStorageProvider.formatSize(totalWritten),
      size_mb: Math.round((totalWritten / (1024 * 1024)) * 100) / 100,
      sha256: digest,
      etag: `"${digest.slice(0, 32)}"`,
      content_type: finalContentType,
      path: path.resolve(targetPath)
    };
  }

  getObject(key: string): string | null {
    const cleanKey = path.basename(key);
    const target = path.join(this.storageDir, cleanKey);
    if (fs.existsSync(target) && fs.statSync(target).isFile()) {
      return target;
    }
    return null;
  }

  async downloadObject(
    key: string,
    rangeHeader?: string | null
  ): Promise<DownloadResult | { status: 416; totalSize: number } | null> {
    const cleanKey = path.basename(key);
    const target = this.getObject(cleanKey);
    if (!target || !fs.existsSync(target)) {
      return null;
    }

    const file = Bun.file(target);
    const fileSize = file.size;
    const meta = this.headObject(cleanKey);
    const etag = meta?.etag || `"${fileSize}"`;
    const contentType = LocalStorageProvider.guessContentType(cleanKey);

    if (rangeHeader) {
      const match = rangeHeader.match(/^bytes=(\d+)-(\d*)/);
      if (match) {
        const start = parseInt(match[1], 10);
        const end = match[2] ? parseInt(match[2], 10) : fileSize - 1;

        if (start >= fileSize || end >= fileSize || start > end) {
          return { status: 416, totalSize: fileSize };
        }

        const slice = file.slice(start, end + 1);
        return {
          stream: slice,
          size: end - start + 1,
          contentType,
          etag,
          range: { start, end, total: fileSize }
        };
      }
    }

    return {
      stream: file,
      size: fileSize,
      contentType,
      etag
    };
  }

  headObject(key: string): StoredObject | null {
    const targetPath = this.getObject(key);
    if (!targetPath) return null;

    const stat = fs.statSync(targetPath);
    const fileName = path.basename(targetPath);
    const sha256Hash = this.getFileSha256(targetPath, stat.mtimeMs);

    return {
      key: fileName,
      name: fileName,
      filename: fileName,
      size_bytes: stat.size,
      size_formatted: LocalStorageProvider.formatSize(stat.size),
      size_mb: Math.round((stat.size / (1024 * 1024)) * 100) / 100,
      sha256: sha256Hash,
      etag: `"${sha256Hash.slice(0, 32)}"`,
      content_type: LocalStorageProvider.guessContentType(fileName),
      modified: formatModifiedTime(stat.mtime),
      path: path.resolve(targetPath)
    };
  }

  deleteObject(key: string): boolean {
    const targetPath = this.getObject(key);
    if (targetPath) {
      try {
        fs.unlinkSync(targetPath);
        const fileName = path.basename(targetPath);
        for (const k of this._hashCache.keys()) {
          if (k.startsWith(`${fileName}_`)) {
            this._hashCache.delete(k);
          }
        }
        console.log(`[STORAGE] Deleted object: ${key}`);
        return true;
      } catch (err) {
        console.error(`[ERROR] deleting object ${key}:`, err);
      }
    }
    return false;
  }

  renameObject(oldKey: string, newKey: string): StoredObject | null {
    const oldName = path.basename(oldKey.trim());
    const newName = path.basename(newKey.trim());
    if (!oldName || !newName) {
      throw new Error("Nama file lama dan baru tidak boleh kosong.");
    }

    const oldPath = this.getObject(oldName);
    if (!oldPath || !fs.existsSync(oldPath)) {
      return null;
    }

    if (oldName === newName) {
      return this.headObject(newName);
    }

    const newPath = path.join(this.storageDir, newName);
    if (fs.existsSync(newPath)) {
      const err = new Error(`File dengan nama '${newName}' sudah ada di storage.`);
      (err as any).code = "EEXIST";
      throw err;
    }

    fs.renameSync(oldPath, newPath);

    for (const k of this._hashCache.keys()) {
      if (k.startsWith(`${oldName}_`)) {
        this._hashCache.delete(k);
      }
    }

    console.log(`[STORAGE] Renamed object: ${oldName} -> ${newName}`);
    return this.headObject(newName);
  }

  getFileSha256(filePath: string, mtime: number): string {
    const fileName = path.basename(filePath);
    const cacheKey = `${fileName}_${mtime}`;
    if (!this._hashCache.has(cacheKey)) {
      try {
        this._hashCache.set(cacheKey, LocalStorageProvider.computeSha256(filePath));
      } catch {
        return "";
      }
    }
    return this._hashCache.get(cacheKey) || "";
  }

  listObjects(serverBaseUrl: string): StoredObject[] {
    const objects: StoredObject[] = [];
    const base = serverBaseUrl.replace(/\/+$/, "");
    const entries = fs.readdirSync(this.storageDir, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isFile() && !entry.name.startsWith(".")) {
        const fullPath = path.join(this.storageDir, entry.name);
        const stat = fs.statSync(fullPath);
        const sha256Hash = this.getFileSha256(fullPath, stat.mtimeMs);
        objects.push({
          key: entry.name,
          name: entry.name,
          filename: entry.name,
          size_bytes: stat.size,
          size_formatted: LocalStorageProvider.formatSize(stat.size),
          size_mb: Math.round((stat.size / (1024 * 1024)) * 100) / 100,
          sha256: sha256Hash,
          etag: `"${sha256Hash.slice(0, 32)}"`,
          modified: formatModifiedTime(stat.mtime),
          content_type: LocalStorageProvider.guessContentType(entry.name),
          url: `${base}/storage/${entry.name}`,
          path: path.resolve(fullPath)
        });
      }
    }

    objects.sort((a, b) => a.name.localeCompare(b.name));
    return objects;
  }

  getStats(): StorageStats {
    let totalBytes = 0;
    let totalObjects = 0;
    let macosCount = 0;
    let windowsCount = 0;
    let linuxCount = 0;
    let archiveCount = 0;
    let otherCount = 0;

    const entries = fs.readdirSync(this.storageDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && !entry.name.startsWith(".")) {
        const fullPath = path.join(this.storageDir, entry.name);
        const stat = fs.statSync(fullPath);
        totalObjects++;
        totalBytes += stat.size;
        const nl = entry.name.toLowerCase();
        if (nl.endsWith(".dmg") || nl.endsWith(".pkg") || nl.endsWith(".app")) {
          macosCount++;
        } else if (nl.endsWith(".exe") || nl.endsWith(".msi")) {
          windowsCount++;
        } else if (nl.endsWith(".appimage") || nl.endsWith(".deb") || nl.endsWith(".rpm")) {
          linuxCount++;
        } else if (
          nl.endsWith(".zip") ||
          nl.endsWith(".tar.gz") ||
          nl.endsWith(".tgz") ||
          nl.endsWith(".tar.xz") ||
          nl.endsWith(".rar")
        ) {
          archiveCount++;
        } else {
          otherCount++;
        }
      }
    }

    return {
      storage_dir: path.resolve(this.storageDir),
      total_objects: totalObjects,
      total_bytes: totalBytes,
      total_formatted: LocalStorageProvider.formatSize(totalBytes),
      macos_count: macosCount,
      windows_count: windowsCount,
      linux_count: linuxCount,
      archive_count: archiveCount,
      other_count: otherCount
    };
  }

  static computeSha256(filePath: string): string {
    const hasher = createHash("sha256");
    const fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(512 * 1024);
    let bytesRead = 0;
    try {
      while ((bytesRead = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
        hasher.update(buf.subarray(0, bytesRead));
      }
    } finally {
      fs.closeSync(fd);
    }
    return hasher.digest("hex");
  }

  static formatSize(bytesVal: number): string {
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

  static guessContentType(filename: string): string {
    const fn = filename.toLowerCase();
    if (fn.endsWith(".dmg")) {
      return "application/x-apple-diskimage";
    }
    if (fn.endsWith(".exe")) {
      return "application/vnd.microsoft.portable-executable";
    }
    if (fn.endsWith(".zip")) {
      return "application/zip";
    }
    if (fn.endsWith(".pkg")) {
      return "application/x-newton-compatible-pkg";
    }
    if (fn.endsWith(".json")) {
      return "application/json";
    }
    return "application/octet-stream";
  }
}

// Backward-compatible alias
export class ObjectStorage extends LocalStorageProvider {}
