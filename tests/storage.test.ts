import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ObjectStorage } from "../src/storage.ts";

describe("ObjectStorage", () => {
  let tmpDir: string;
  let storage: ObjectStorage;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "storage-test-"));
    storage = new ObjectStorage(tmpDir);
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("should put object and retrieve head object metadata", async () => {
    const payload = Buffer.from("Mock authentic installer payload for METDesk v2.3.1");
    const info = await storage.putObject(
      "METDesk-2.3.1.dmg",
      payload,
      payload.length
    );

    expect(info.key).toBe("METDesk-2.3.1.dmg");
    expect(info.size_bytes).toBe(payload.length);
    expect(info.content_type).toBe("application/x-apple-diskimage");
    expect(info.sha256).toBeDefined();
    expect(info.sha256.length).toBe(64);
    expect(fs.existsSync(path.join(tmpDir, "METDesk-2.3.1.dmg"))).toBeTrue();

    // Head object metadata
    const meta = storage.headObject("METDesk-2.3.1.dmg");
    expect(meta).not.toBeNull();
    expect(meta?.key).toBe("METDesk-2.3.1.dmg");
    expect(meta?.size_bytes).toBe(payload.length);
    expect(meta?.sha256).toBe(info.sha256);
    expect(meta?.etag).toBe(`"${info.sha256.slice(0, 32)}"`);
  });

  it("should stream upload using ReadableStream", async () => {
    const payload = new Uint8Array([10, 20, 30, 40, 50]);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(payload);
        controller.close();
      }
    });

    const info = await storage.putObject("test-stream.zip", stream, payload.length);
    expect(info.key).toBe("test-stream.zip");
    expect(info.size_bytes).toBe(5);
    expect(info.content_type).toBe("application/zip");
    expect(storage.headObject("test-stream.zip")?.size_bytes).toBe(5);
  });

  it("should list objects and calculate stats", async () => {
    await storage.putObject("METDesk-1.dmg", Buffer.from("file1"), 5);
    await storage.putObject("METDesk-2.exe", Buffer.from("file2"), 5);

    const objects = storage.listObjects("http://localhost:3001");
    expect(objects.length).toBe(2);
    expect(objects[0].name).toBe("METDesk-1.dmg");
    expect(objects[0].url).toBe("http://localhost:3001/storage/METDesk-1.dmg");

    const stats = storage.getStats();
    expect(stats.total_objects).toBe(2);
    expect(stats.total_bytes).toBe(10);
    expect(stats.macos_count).toBe(1);
    expect(stats.windows_count).toBe(1);
  });

  it("should delete object from storage", async () => {
    await storage.putObject("to-delete.exe", Buffer.from("data"), 4);
    expect(fs.existsSync(path.join(tmpDir, "to-delete.exe"))).toBeTrue();

    const deleted = storage.deleteObject("to-delete.exe");
    expect(deleted).toBeTrue();
    expect(fs.existsSync(path.join(tmpDir, "to-delete.exe"))).toBeFalse();

    const deleteAgain = storage.deleteObject("to-delete.exe");
    expect(deleteAgain).toBeFalse();
  });

  it("should rename object", async () => {
    await storage.putObject("old-name.dmg", Buffer.from("dmg_payload"), 11);
    expect(fs.existsSync(path.join(tmpDir, "old-name.dmg"))).toBeTrue();

    const renamed = storage.renameObject("old-name.dmg", "new-name.dmg");
    expect(renamed).not.toBeNull();
    expect(renamed?.key).toBe("new-name.dmg");
    expect(fs.existsSync(path.join(tmpDir, "old-name.dmg"))).toBeFalse();
    expect(fs.existsSync(path.join(tmpDir, "new-name.dmg"))).toBeTrue();

    // Cannot rename to existing file
    await storage.putObject("conflict.dmg", Buffer.from("conflict"), 8);
    expect(() => {
      storage.renameObject("new-name.dmg", "conflict.dmg");
    }).toThrow();
  });

  it("should validate authorization header and API key", () => {
    const originalKey = process.env.UPLOAD_AUTH_KEY;
    try {
      // 1. No secret configured -> open access
      process.env.UPLOAD_AUTH_KEY = "";
      expect(storage.isAuthValid(null, null)).toBeTrue();

      // 2. Secret configured -> requires matching key
      process.env.UPLOAD_AUTH_KEY = "super_secret_123";
      expect(storage.isAuthValid(null, null)).toBeFalse();
      expect(storage.isAuthValid(null, "wrong_key")).toBeFalse();
      expect(storage.isAuthValid(null, "super_secret_123")).toBeTrue();
      expect(storage.isAuthValid("Bearer super_secret_123", null)).toBeTrue();
      expect(storage.isAuthValid("Bearer wrong_key", null)).toBeFalse();
      expect(storage.isAuthValid("super_secret_123", null)).toBeTrue();
    } finally {
      if (originalKey !== undefined) {
        process.env.UPLOAD_AUTH_KEY = originalKey;
      } else {
        delete process.env.UPLOAD_AUTH_KEY;
      }
    }
  });

  it("should format sizes and guess MIME types correctly", () => {
    expect(ObjectStorage.formatSize(500)).toBe("500 B");
    expect(ObjectStorage.formatSize(2048)).toBe("2.0 KB");
    expect(ObjectStorage.formatSize(1048576 * 5)).toBe("5.00 MB");
    expect(ObjectStorage.formatSize(1073741824 * 2.5)).toBe("2.50 GB");

    expect(ObjectStorage.guessContentType("test.dmg")).toBe("application/x-apple-diskimage");
    expect(ObjectStorage.guessContentType("test.exe")).toBe("application/vnd.microsoft.portable-executable");
    expect(ObjectStorage.guessContentType("test.zip")).toBe("application/zip");
    expect(ObjectStorage.guessContentType("test.pkg")).toBe("application/x-newton-compatible-pkg");
    expect(ObjectStorage.guessContentType("test.json")).toBe("application/json");
    expect(ObjectStorage.guessContentType("test.unknown")).toBe("application/octet-stream");
  });
});
