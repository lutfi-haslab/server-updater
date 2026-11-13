/**
 * Cloudflare R2 Storage Provider for METDesk Update Server.
 * Used for Cloudflare Workers (Development & Preview).
 */

import { createHash } from "node:crypto";
import path from "node:path";
import type { StorageStats, StoredObject } from "../types.ts";
import type { DownloadResult, StorageProvider } from "./types.ts";
import { formatModifiedTime, formatSize, guessContentType } from "./utils.ts";

// Minimal R2 type bindings to avoid strict dependency on global types during testing
export interface R2BucketLike {
  put(
    key: string,
    value: any,
    options?: {
      httpMetadata?: {
        contentType?: string;
        contentLanguage?: string;
        contentDisposition?: string;
        cacheControl?: string;
      };
      customMetadata?: Record<string, string>;
      sha256?: ArrayBuffer | string;
    }
  ): Promise<any>;
  get(key: string, options?: { range?: any }): Promise<any>;
  head(key: string): Promise<any>;
  delete(keys: string | string[]): Promise<any>;
  list(options?: { prefix?: string; cursor?: string; limit?: number }): Promise<{
    objects: Array<{
      key: string;
      size: number;
      etag: string;
      httpEtag?: string;
      uploaded: Date;
      httpMetadata?: { contentType?: string };
      customMetadata?: Record<string, string>;
    }>;
  }>;
}

export class R2StorageProvider implements StorageProvider {
  public readonly storageName = "cloudflare-r2";
  public readonly bucket: R2BucketLike;
  private readonly uploadAuthKey: string;

  constructor(bucket: R2BucketLike, uploadAuthKey: string = "") {
    this.bucket = bucket;
    this.uploadAuthKey = uploadAuthKey.trim();
  }

  isAuthValid(authHeader?: string | null, apiKeyHeader?: string | null): boolean {
    if (!this.uploadAuthKey) {
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

    return providedKey === this.uploadAuthKey;
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
    const finalContentType = contentType || guessContentType(cleanKey);

    let bodyData: any = stream;
    let digest = "";
    let totalWritten = 0;

    if (stream instanceof Uint8Array || Buffer.isBuffer(stream)) {
      let chunk: Uint8Array = stream;
      if (sizeBytes !== undefined && chunk.length > sizeBytes) {
        chunk = chunk.subarray(0, sizeBytes);
      }
      totalWritten = chunk.length;
      digest = createHash("sha256").update(chunk).digest("hex");
      bodyData = chunk;
    } else if (typeof (stream as any).getReader === "function") {
      // ReadableStream
      const hasher = createHash("sha256");
      const chunks: Uint8Array[] = [];
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
        chunks.push(slice);
        totalWritten += slice.length;
        if (sizeBytes !== undefined && totalWritten >= sizeBytes) {
          break;
        }
      }
      digest = hasher.digest("hex");
      // Combine chunks into single Buffer / Uint8Array
      const merged = new Uint8Array(totalWritten);
      let offset = 0;
      for (const c of chunks) {
        merged.set(c, offset);
        offset += c.length;
      }
      bodyData = merged;
    } else if (typeof (stream as any)[Symbol.asyncIterator] === "function") {
      const hasher = createHash("sha256");
      const chunks: Uint8Array[] = [];
      for await (const chunk of stream as AsyncIterable<Uint8Array>) {
        let slice = chunk;
        if (sizeBytes !== undefined && totalWritten + slice.length > sizeBytes) {
          slice = slice.subarray(0, sizeBytes - totalWritten);
        }
        if (slice.length === 0) break;
        hasher.update(slice);
        chunks.push(slice);
        totalWritten += slice.length;
        if (sizeBytes !== undefined && totalWritten >= sizeBytes) {
          break;
        }
      }
      digest = hasher.digest("hex");
      const merged = new Uint8Array(totalWritten);
      let offset = 0;
      for (const c of chunks) {
        merged.set(c, offset);
        offset += c.length;
      }
      bodyData = merged;
    }

    const r2Obj = await this.bucket.put(cleanKey, bodyData, {
      httpMetadata: {
        contentType: finalContentType
      },
      customMetadata: {
        sha256: digest
      }
    });

    console.log(
      `[R2-STORAGE] Stored object: ${cleanKey} (${formatSize(totalWritten)}, sha256=${digest.slice(0, 12)}...)`
    );

    return {
      key: cleanKey,
      name: cleanKey,
      filename: cleanKey,
      size_bytes: totalWritten,
      size_formatted: formatSize(totalWritten),
      size_mb: Math.round((totalWritten / (1024 * 1024)) * 100) / 100,
      sha256: digest,
      etag: r2Obj?.httpEtag || `"${digest.slice(0, 32)}"`,
      content_type: finalContentType
    };
  }

  async downloadObject(
    key: string,
    rangeHeader?: string | null
  ): Promise<DownloadResult | { status: 416; totalSize: number } | null> {
    const cleanKey = path.basename(key);

    if (rangeHeader) {
      const match = rangeHeader.match(/^bytes=(\d+)-(\d*)/);
      if (match) {
        const head = await this.bucket.head(cleanKey);
        if (!head) return null;
        const fileSize = head.size;
        const start = parseInt(match[1], 10);
        const end = match[2] ? parseInt(match[2], 10) : fileSize - 1;

        if (start >= fileSize || end >= fileSize || start > end) {
          return { status: 416, totalSize: fileSize };
        }

        const length = end - start + 1;
        const obj = await this.bucket.get(cleanKey, {
          range: { offset: start, length }
        });
        if (!obj) return null;

        return {
          stream: obj.body,
          size: length,
          contentType:
            obj.httpMetadata?.contentType || guessContentType(cleanKey),
          etag: obj.httpEtag || `"${head.etag}"`,
          range: { start, end, total: fileSize }
        };
      }
    }

    const obj = await this.bucket.get(cleanKey);
    if (!obj) return null;

    return {
      stream: obj.body,
      size: obj.size,
      contentType: obj.httpMetadata?.contentType || guessContentType(cleanKey),
      etag: obj.httpEtag || `"${obj.etag}"`
    };
  }

  async headObject(key: string): Promise<StoredObject | null> {
    const cleanKey = path.basename(key);
    const obj = await this.bucket.head(cleanKey);
    if (!obj) return null;

    const sha256 = obj.customMetadata?.sha256 || obj.etag || "";
    return {
      key: cleanKey,
      name: cleanKey,
      filename: cleanKey,
      size_bytes: obj.size,
      size_formatted: formatSize(obj.size),
      size_mb: Math.round((obj.size / (1024 * 1024)) * 100) / 100,
      sha256,
      etag: obj.httpEtag || `"${obj.etag}"`,
      content_type: obj.httpMetadata?.contentType || guessContentType(cleanKey),
      modified: obj.uploaded ? formatModifiedTime(new Date(obj.uploaded)) : undefined
    };
  }

  async deleteObject(key: string): Promise<boolean> {
    const cleanKey = path.basename(key);
    try {
      await this.bucket.delete(cleanKey);
      console.log(`[R2-STORAGE] Deleted object: ${cleanKey}`);
      return true;
    } catch (err) {
      console.error(`[ERROR] deleting R2 object ${cleanKey}:`, err);
      return false;
    }
  }

  async renameObject(oldKey: string, newKey: string): Promise<StoredObject | null> {
    const oldName = path.basename(oldKey.trim());
    const newName = path.basename(newKey.trim());
    if (!oldName || !newName) {
      throw new Error("Nama file lama dan baru tidak boleh kosong.");
    }

    const existingTarget = await this.bucket.head(newName);
    if (existingTarget) {
      const err = new Error(`File dengan nama '${newName}' sudah ada di storage.`);
      (err as any).code = "EEXIST";
      throw err;
    }

    const oldObj = await this.bucket.get(oldName);
    if (!oldObj) return null;

    await this.bucket.put(newName, oldObj.body, {
      httpMetadata: oldObj.httpMetadata,
      customMetadata: oldObj.customMetadata
    });
    await this.bucket.delete(oldName);

    console.log(`[R2-STORAGE] Renamed object: ${oldName} -> ${newName}`);
    return this.headObject(newName);
  }

  async listObjects(serverBaseUrl: string): Promise<StoredObject[]> {
    const base = serverBaseUrl.replace(/\/+$/, "");
    const list = await this.bucket.list();
    const objects: StoredObject[] = [];

    for (const obj of list.objects || []) {
      if (obj.key === "release.json" || obj.key.startsWith(".")) {
        continue;
      }
      const sha256 = obj.customMetadata?.sha256 || obj.etag || "";
      objects.push({
        key: obj.key,
        name: obj.key,
        filename: obj.key,
        size_bytes: obj.size,
        size_formatted: formatSize(obj.size),
        size_mb: Math.round((obj.size / (1024 * 1024)) * 100) / 100,
        sha256,
        etag: obj.httpEtag || `"${obj.etag}"`,
        modified: obj.uploaded ? formatModifiedTime(new Date(obj.uploaded)) : undefined,
        content_type: obj.httpMetadata?.contentType || guessContentType(obj.key),
        url: `${base}/storage/${obj.key}`
      });
    }

    objects.sort((a, b) => a.name.localeCompare(b.name));
    return objects;
  }

  async getStats(): Promise<StorageStats> {
    let totalBytes = 0;
    let totalObjects = 0;
    let macosCount = 0;
    let windowsCount = 0;
    let linuxCount = 0;
    let archiveCount = 0;
    let otherCount = 0;

    const list = await this.bucket.list();
    for (const obj of list.objects || []) {
      if (obj.key === "release.json" || obj.key.startsWith(".")) {
        continue;
      }
      totalObjects++;
      totalBytes += obj.size;
      const nl = obj.key.toLowerCase();
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

    return {
      storage_dir: "r2://bucket",
      total_objects: totalObjects,
      total_bytes: totalBytes,
      total_formatted: formatSize(totalBytes),
      macos_count: macosCount,
      windows_count: windowsCount,
      linux_count: linuxCount,
      archive_count: archiveCount,
      other_count: otherCount
    };
  }
}
