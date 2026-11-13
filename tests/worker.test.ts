import { describe, expect, it } from "bun:test";
import worker from "../src/worker.ts";

// Simple In-Memory Mock of Cloudflare R2 Bucket
class MockR2Bucket {
  private store = new Map<string, { body: Uint8Array; metadata: any; customMetadata: any }>();

  async put(key: string, value: any, options?: any) {
    let bytes: Uint8Array;
    if (value instanceof Uint8Array) {
      bytes = value;
    } else if (typeof value === "string") {
      bytes = Buffer.from(value);
    } else if (value && typeof value.getReader === "function") {
      const reader = value.getReader();
      const chunks: Uint8Array[] = [];
      while (true) {
        const { done, value: chunk } = await reader.read();
        if (done) break;
        if (chunk) chunks.push(chunk);
      }
      const total = chunks.reduce((acc, c) => acc + c.length, 0);
      bytes = new Uint8Array(total);
      let offset = 0;
      for (const c of chunks) {
        bytes.set(c, offset);
        offset += c.length;
      }
    } else {
      bytes = new Uint8Array(0);
    }

    this.store.set(key, {
      body: bytes,
      metadata: options?.httpMetadata || {},
      customMetadata: options?.customMetadata || {}
    });

    return {
      key,
      size: bytes.length,
      etag: "mock-etag",
      httpEtag: '"mock-etag"',
      uploaded: new Date()
    };
  }

  async get(key: string, options?: any) {
    const item = this.store.get(key);
    if (!item) return null;

    let slice = item.body;
    let rangeMeta: any = undefined;

    if (options?.range) {
      const { offset, length } = options.range;
      slice = item.body.subarray(offset, offset + length);
      rangeMeta = { offset, length };
    }

    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(slice);
        controller.close();
      }
    });

    return {
      key,
      size: slice.length,
      etag: "mock-etag",
      httpEtag: '"mock-etag"',
      body: stream,
      httpMetadata: item.metadata,
      customMetadata: item.customMetadata,
      range: rangeMeta,
      async text() {
        return Buffer.from(slice).toString("utf-8");
      },
      async json() {
        return JSON.parse(Buffer.from(slice).toString("utf-8"));
      }
    };
  }

  async head(key: string) {
    const item = this.store.get(key);
    if (!item) return null;
    return {
      key,
      size: item.body.length,
      etag: "mock-etag",
      httpEtag: '"mock-etag"',
      uploaded: new Date(),
      httpMetadata: item.metadata,
      customMetadata: item.customMetadata
    };
  }

  async delete(key: string) {
    this.store.delete(key);
  }

  async list() {
    const objects = Array.from(this.store.entries()).map(([k, v]) => ({
      key: k,
      size: v.body.length,
      etag: "mock-etag",
      httpEtag: '"mock-etag"',
      uploaded: new Date(),
      httpMetadata: v.metadata,
      customMetadata: v.customMetadata
    }));
    return { objects };
  }
}

describe("Cloudflare Worker Target (Dev/R2)", () => {
  const mockBucket = new MockR2Bucket();
  const env = {
    BINARIES_BUCKET: mockBucket,
    ADMIN_USERNAME: "devadmin",
    ADMIN_PASSWORD: "devpassword123",
    UPLOAD_AUTH_KEY: "dev_api_key"
  };

  it("1. GET /health should return ok and storage: 'cloudflare-r2'", async () => {
    const req = new Request("https://metdesk-dev.workers.dev/health");
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.status).toBe("ok");
    expect(data.storage).toBe("cloudflare-r2");
    expect(data.auth_required).toBeTrue();
  });

  it("2. PUT /storage/METDesk-dev.dmg should upload to R2 and auto-update release.json in R2", async () => {
    const payload = Buffer.from("simulated installer bytes for cloudflare workers dev");
    const req = new Request(
      "https://metdesk-dev.workers.dev/storage/METDesk-2.4.0-dev.dmg?update_release=true&platform=macos",
      {
        method: "PUT",
        headers: {
          "X-API-Key": "dev_api_key",
          "Content-Type": "application/x-apple-diskimage",
          "Content-Length": String(payload.length)
        },
        body: payload
      }
    );

    const res = await worker.fetch(req, env);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBeTrue();
    expect(data.object.key).toBe("METDesk-2.4.0-dev.dmg");
    expect(data.object.sha256).toBeDefined();

    // Verify release.json stored in R2
    const releaseRes = await worker.fetch(
      new Request("https://metdesk-dev.workers.dev/updates?raw=true"),
      env
    );
    expect(releaseRes.status).toBe(200);
    const releaseData = await releaseRes.json();
    expect(releaseData.version).toBe("2.4.0");
    expect(releaseData.downloads.macos.filename).toBe("METDesk-2.4.0-dev.dmg");
  });

  it("3. GET /storage/:filename should stream download from R2 with Range support", async () => {
    // Full download
    const fullReq = new Request("https://metdesk-dev.workers.dev/storage/METDesk-2.4.0-dev.dmg");
    const fullRes = await worker.fetch(fullReq, env);
    expect(fullRes.status).toBe(200);
    expect(fullRes.headers.get("Accept-Ranges")).toBe("bytes");
    const fullText = await fullRes.text();
    expect(fullText).toContain("simulated installer bytes");

    // Range download
    const rangeReq = new Request("https://metdesk-dev.workers.dev/storage/METDesk-2.4.0-dev.dmg", {
      headers: { Range: "bytes=0-8" }
    });
    const rangeRes = await worker.fetch(rangeReq, env);
    expect(rangeRes.status).toBe(206);
    expect(rangeRes.headers.get("Content-Range")).toBe(`bytes 0-8/${fullText.length}`);
    const rangeText = await rangeRes.text();
    expect(rangeText).toBe("simulated");
  });

  it("4. POST /api/storage/rename should rename binary in R2", async () => {
    const req = new Request("https://metdesk-dev.workers.dev/api/storage/rename", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": "dev_api_key"
      },
      body: JSON.stringify({
        old_name: "METDesk-2.4.0-dev.dmg",
        new_name: "METDesk-2.4.0-final.dmg",
        update_release: true
      })
    });

    const res = await worker.fetch(req, env);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBeTrue();
    expect(data.object.name).toBe("METDesk-2.4.0-final.dmg");

    // Check updates endpoint
    const updatesRes = await worker.fetch(
      new Request("https://metdesk-dev.workers.dev/updates"),
      env
    );
    const updatesData = await updatesRes.json();
    expect(updatesData.downloads.macos.filename).toBe("METDesk-2.4.0-final.dmg");
  });

  it("5. Admin UI GET /admin and mock endpoints work on Worker", async () => {
    const adminRes = await worker.fetch(
      new Request("https://metdesk-dev.workers.dev/admin"),
      env
    );
    expect(adminRes.status).toBe(200);
    expect(adminRes.headers.get("Content-Type")).toContain("text/html");

    const licRes = await worker.fetch(
      new Request("https://metdesk-dev.workers.dev/license"),
      env
    );
    expect(licRes.status).toBe(200);
    expect((await licRes.json()).valid).toBeTrue();
  });

  it("6. Should reject non-binary uploads like .jpeg on Worker", async () => {
    const req = new Request(
      "https://metdesk-dev.workers.dev/storage/avatar.jpeg",
      {
        method: "PUT",
        headers: {
          "X-API-Key": "dev_api_key",
          "Content-Type": "image/jpeg"
        },
        body: Buffer.from("image bytes")
      }
    );

    const res = await worker.fetch(req, env);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.success).toBeFalse();
    expect(data.error).toContain("Hanya file installer dan binary desktop");
  });
});
