import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createUpdateServer, saveReleaseData } from "../src/server.ts";

describe("UpdateServer HTTP API", () => {
  let tmpDir: string;
  let releaseFile: string;
  let adminHtml: string;
  let serverInstance: ReturnType<typeof createUpdateServer>;
  let baseUrl: string;
  let sessionCookie: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "server-test-"));
    releaseFile = path.join(tmpDir, "release.json");
    adminHtml = path.join(tmpDir, "admin.html");

    fs.writeFileSync(adminHtml, "<!DOCTYPE html><html><body>Test Admin</body></html>", "utf-8");

    saveReleaseData(releaseFile, {
      version: "2.3.0",
      downloads: {
        macos: {
          filename: "test.dmg",
          url: "http://localhost:3001/storage/test.dmg"
        }
      }
    });

    process.env.ADMIN_USERNAME = "admin";
    process.env.ADMIN_PASSWORD = "admin123";
    process.env.UPLOAD_AUTH_KEY = "ci_secret_key";

    serverInstance = createUpdateServer({
      port: 0,
      storageDir: tmpDir,
      releaseFilePath: releaseFile,
      adminHtmlPath: adminHtml
    });

    baseUrl = `http://127.0.0.1:${serverInstance.port}`;
  });

  afterEach(() => {
    serverInstance.stop();
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("1. GET /health should return ok status", async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe("ok");
    expect(data.service).toBe("metdesk-update-server");
    expect(data.auth_required).toBeTrue();
  });

  it("2. POST /api/login should authenticate and return session cookie", async () => {
    // Bad credentials
    const badRes = await fetch(`${baseUrl}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "wrong_password" })
    });
    expect(badRes.status).toBe(401);

    // Good credentials
    const res = await fetch(`${baseUrl}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "admin123" })
    });

    expect(res.status).toBe(200);
    const cookie = res.headers.get("Set-Cookie");
    expect(cookie).not.toBeNull();
    expect(cookie).toContain("session=");
    const data = await res.json();
    expect(data.success).toBeTrue();
    expect(data.token).toBeDefined();

    // Check /api/auth/status with session cookie
    const authStatusRes = await fetch(`${baseUrl}/api/auth/status`, {
      headers: { Cookie: cookie! }
    });
    const authStatus = await authStatusRes.json();
    expect(authStatus.is_authenticated).toBeTrue();
    expect(authStatus.username).toBe("admin");

    // Logout
    const logoutRes = await fetch(`${baseUrl}/api/logout`, {
      method: "POST",
      headers: { Cookie: cookie! }
    });
    expect(logoutRes.status).toBe(200);
    const logoutData = await logoutRes.json();
    expect(logoutData.success).toBeTrue();
  });

  it("3. PUT /storage/METDesk-2.3.1.dmg with X-API-Key should stream upload binary", async () => {
    const content = Buffer.from("sample dmg content for testing range and streaming");
    const uploadRes = await fetch(`${baseUrl}/storage/METDesk-2.3.1.dmg?update_release=true&platform=macos`, {
      method: "PUT",
      headers: {
        "X-API-Key": "ci_secret_key",
        "Content-Length": String(content.length),
        "Content-Type": "application/x-apple-diskimage"
      },
      body: content
    });

    expect(uploadRes.status).toBe(200);
    const data = await uploadRes.json();
    expect(data.success).toBeTrue();
    expect(data.object.key).toBe("METDesk-2.3.1.dmg");
    expect(data.object.size_bytes).toBe(content.length);
    expect(data.object.release_updated).toBeTrue();
  });

  it("4. GET /storage/METDesk-2.3.1.dmg should support full download, HTTP 206 Range requests, and 416 on invalid range", async () => {
    const filePath = path.join(tmpDir, "METDesk-2.3.1.dmg");
    const content = Buffer.from("0123456789ABCDEF");
    fs.writeFileSync(filePath, content);

    // Full GET (200)
    const fullRes = await fetch(`${baseUrl}/storage/METDesk-2.3.1.dmg`);
    expect(fullRes.status).toBe(200);
    expect(fullRes.headers.get("Accept-Ranges")).toBe("bytes");
    expect(await fullRes.text()).toBe("0123456789ABCDEF");

    // Partial Content (206)
    const rangeRes = await fetch(`${baseUrl}/storage/METDesk-2.3.1.dmg`, {
      headers: { Range: "bytes=2-6" }
    });
    expect(rangeRes.status).toBe(206);
    expect(rangeRes.headers.get("Content-Range")).toBe(`bytes 2-6/${content.length}`);
    expect(rangeRes.headers.get("Content-Length")).toBe("5");
    expect(await rangeRes.text()).toBe("23456");

    // Invalid Range (416)
    const outOfRangeRes = await fetch(`${baseUrl}/storage/METDesk-2.3.1.dmg`, {
      headers: { Range: "bytes=100-200" }
    });
    expect(outOfRangeRes.status).toBe(416);
    expect(outOfRangeRes.headers.get("Content-Range")).toBe(`bytes */${content.length}`);

    // HEAD request
    const headRes = await fetch(`${baseUrl}/storage/METDesk-2.3.1.dmg`, {
      method: "HEAD"
    });
    expect(headRes.status).toBe(200);
    expect(headRes.headers.get("Content-Length")).toBe(String(content.length));
    expect(await headRes.text()).toBe("");
  });

  it("5. POST /api/storage/rename should rename binary and update release.json", async () => {
    fs.writeFileSync(path.join(tmpDir, "METDesk-2.3.1.dmg"), Buffer.from("dmg payload"));

    const renameRes = await fetch(`${baseUrl}/api/storage/rename`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": "ci_secret_key"
      },
      body: JSON.stringify({
        old_name: "METDesk-2.3.1.dmg",
        new_name: "METDesk-2.3.1-renamed.dmg"
      })
    });

    expect(renameRes.status).toBe(200);
    const data = await renameRes.json();
    expect(data.success).toBeTrue();
    expect(data.object.key).toBe("METDesk-2.3.1-renamed.dmg");
    expect(fs.existsSync(path.join(tmpDir, "METDesk-2.3.1-renamed.dmg"))).toBeTrue();
  });

  it("6. POST /api/storage/set-active should update active platform binary", async () => {
    fs.writeFileSync(path.join(tmpDir, "METDesk-2.3.1-renamed.dmg"), Buffer.from("dmg payload"));

    const activeRes = await fetch(`${baseUrl}/api/storage/set-active`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": "ci_secret_key"
      },
      body: JSON.stringify({
        filename: "METDesk-2.3.1-renamed.dmg",
        platform: "macos",
        version: "2.3.1"
      })
    });

    expect(activeRes.status).toBe(200);
    const data = await activeRes.json();
    expect(data.success).toBeTrue();
    expect(data.data.version).toBe("2.3.1");
    expect(data.data.downloads.macos.filename).toBe("METDesk-2.3.1-renamed.dmg");

    // Check GET /api/binaries
    const listRes = await fetch(`${baseUrl}/api/binaries`);
    const listData = await listRes.json();
    expect(listData.success).toBeTrue();
    const found = listData.objects.find((o: any) => o.name === "METDesk-2.3.1-renamed.dmg");
    expect(found).toBeDefined();
    expect(found.is_active_macos).toBeTrue();

    // Check GET /updates
    const updatesRes = await fetch(`${baseUrl}/updates`);
    const updatesData = await updatesRes.json();
    expect(updatesData.downloads.macos.filename).toBe("METDesk-2.3.1-renamed.dmg");
    expect(updatesData.downloads.macos.url).toContain("/storage/METDesk-2.3.1-renamed.dmg");
  });

  it("7. POST /api/storage/bulk-delete and DELETE /storage/:file", async () => {
    fs.writeFileSync(path.join(tmpDir, "file-a.dmg"), Buffer.from("a"));
    fs.writeFileSync(path.join(tmpDir, "file-b.exe"), Buffer.from("b"));
    fs.writeFileSync(path.join(tmpDir, "file-c.zip"), Buffer.from("c"));

    // Bulk delete
    const bulkRes = await fetch(`${baseUrl}/api/storage/bulk-delete`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": "ci_secret_key"
      },
      body: JSON.stringify({ filenames: ["file-a.dmg", "file-b.exe"] })
    });

    expect(bulkRes.status).toBe(200);
    const data = await bulkRes.json();
    expect(data.success).toBeTrue();
    expect(data.deleted).toContain("file-a.dmg");
    expect(data.deleted).toContain("file-b.exe");

    // Single DELETE
    const singleDelRes = await fetch(`${baseUrl}/storage/file-c.zip`, {
      method: "DELETE",
      headers: { "X-API-Key": "ci_secret_key" }
    });
    expect(singleDelRes.status).toBe(200);
    expect(fs.existsSync(path.join(tmpDir, "file-c.zip"))).toBeFalse();
  });

  it("8. POST /api/upload multipart form and direct binary upload", async () => {
    // Case A: Multipart
    const fd = new FormData();
    fd.append("file", new File([Buffer.from("multipart dmg payload")], "METDesk-multipart.dmg", {
      type: "application/x-apple-diskimage"
    }));

    const uploadRes = await fetch(`${baseUrl}/storage`, {
      method: "POST",
      headers: { "X-API-Key": "ci_secret_key" },
      body: fd
    });

    expect(uploadRes.status).toBe(200);
    const data = await uploadRes.json();
    expect(data.success).toBeTrue();
    expect(data.object.key).toBe("METDesk-multipart.dmg");

    // Case B: Direct binary with ?filename=
    const directRes = await fetch(`${baseUrl}/storage?filename=METDesk-direct.dmg`, {
      method: "POST",
      headers: {
        "X-API-Key": "ci_secret_key",
        "Content-Type": "application/x-apple-diskimage"
      },
      body: Buffer.from("direct binary payload")
    });

    expect(directRes.status).toBe(200);
    const directData = await directRes.json();
    expect(directData.success).toBeTrue();
    expect(directData.object.key).toBe("METDesk-direct.dmg");
  });

  it("9. Sample binary generation via POST /api/generate-binary", async () => {
    const genRes = await fetch(`${baseUrl}/api/generate-binary`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": "ci_secret_key"
      },
      body: JSON.stringify({
        filename: "METDesk-sample.exe",
        size_mb: 1
      })
    });

    expect(genRes.status).toBe(200);
    const data = await genRes.json();
    expect(data.success).toBeTrue();
    expect(data.filename).toBe("METDesk-sample.exe");
    expect(fs.existsSync(path.join(tmpDir, "METDesk-sample.exe"))).toBeTrue();
  });

  it("10. Mock endpoints /license, /quota and GUI /admin", async () => {
    const licRes = await fetch(`${baseUrl}/license`);
    expect(licRes.status).toBe(200);
    expect((await licRes.json()).valid).toBeTrue();

    const quotaRes = await fetch(`${baseUrl}/quota`);
    expect(quotaRes.status).toBe(200);
    expect((await quotaRes.json()).balance).toBe(150);

    const adminRes = await fetch(`${baseUrl}/admin`);
    expect(adminRes.status).toBe(200);
    expect(await adminRes.text()).toContain("Test Admin");
  });

  it("11. Unauthorized access should be blocked", async () => {
    const unauthedRes = await fetch(`${baseUrl}/storage/unauthorized.dmg`, {
      method: "PUT",
      body: Buffer.from("hack")
    });
    expect(unauthedRes.status).toBe(401);

    const unauthedDel = await fetch(`${baseUrl}/storage/unauthorized.dmg`, {
      method: "DELETE"
    });
    expect(unauthedDel.status).toBe(401);
  });

  it("12. Disallowed file extensions should be rejected with 400", async () => {
    // PUT non-binary file (e.g. .jpeg)
    const putRes = await fetch(`${baseUrl}/storage/photo.jpeg`, {
      method: "PUT",
      headers: {
        "X-API-Key": "ci_secret_key",
        "Content-Type": "image/jpeg"
      },
      body: Buffer.from("fake jpeg")
    });
    expect(putRes.status).toBe(400);
    const putData = await putRes.json();
    expect(putData.success).toBeFalse();
    expect(putData.error).toContain("Hanya file installer dan binary desktop");

    // POST multipart non-binary file
    const fd = new FormData();
    fd.append("file", new File([Buffer.from("fake png")], "avatar.png", { type: "image/png" }));
    const postRes = await fetch(`${baseUrl}/storage`, {
      method: "POST",
      headers: { "X-API-Key": "ci_secret_key" },
      body: fd
    });
    expect(postRes.status).toBe(400);
    const postData = await postRes.json();
    expect(postData.success).toBeFalse();
    expect(postData.error).toContain("Hanya file installer dan binary desktop");

    // Allowed Linux AppImage should succeed
    const linuxPayload = Buffer.from("linux appimage content");
    const linuxRes = await fetch(`${baseUrl}/storage/METDesk-2.3.1.AppImage?update_release=true`, {
      method: "PUT",
      headers: {
        "X-API-Key": "ci_secret_key",
        "Content-Length": String(linuxPayload.length)
      },
      body: linuxPayload
    });
    expect(linuxRes.status).toBe(200);
    const linuxData = await linuxRes.json();
    expect(linuxData.success).toBeTrue();
    expect(linuxData.object.key).toBe("METDesk-2.3.1.AppImage");
  });

  it("13. Release draft management: save, retrieve, and clear draft", async () => {
    // 1. Initial draft should be empty
    const getRes1 = await fetch(`${baseUrl}/api/release/draft`);
    expect(getRes1.status).toBe(200);
    const data1 = await getRes1.json();
    expect(data1.success).toBeTrue();

    // 2. Save draft
    const draftPayload = {
      version: "2.4.0-draft",
      type: "minor",
      summary: "Draft feature work in progress",
      changelog: [{ type: "feature", category: "Baru", text: "Fitur baru draft" }],
      downloads: {}
    };

    const postDraft = await fetch(`${baseUrl}/api/release/draft`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": "ci_secret_key"
      },
      body: JSON.stringify(draftPayload)
    });
    expect(postDraft.status).toBe(200);
    const postDraftData = await postDraft.json();
    expect(postDraftData.success).toBeTrue();
    expect(postDraftData.draft.version).toBe("2.4.0-draft");

    // 3. Retrieve saved draft
    const getRes2 = await fetch(`${baseUrl}/api/release/draft`);
    const data2 = await getRes2.json();
    expect(data2.draft).not.toBeNull();
    expect(data2.draft.version).toBe("2.4.0-draft");

    // 4. Clear draft
    const delRes = await fetch(`${baseUrl}/api/release/draft`, {
      method: "DELETE",
      headers: { "X-API-Key": "ci_secret_key" }
    });
    expect(delRes.status).toBe(200);

    const getRes3 = await fetch(`${baseUrl}/api/release/draft`);
    const data3 = await getRes3.json();
    expect(data3.draft).toBeNull();
  });

  it("14. Publish release, sync to changelog history, and test rollback", async () => {
    // 1. Upload a binary to attach
    const binPayload = Buffer.from("installer binary content 2.5.0");
    await fetch(`${baseUrl}/storage/METDesk-2.5.0.exe`, {
      method: "PUT",
      headers: {
        "X-API-Key": "ci_secret_key",
        "Content-Length": String(binPayload.length)
      },
      body: binPayload
    });

    // 2. Publish release v2.5.0
    const publishPayload = {
      version: "2.5.0",
      type: "major",
      summary: "Major release v2.5.0",
      changelog: [{ type: "feature", category: "Baru", text: "All new engine" }],
      downloads: {
        windows: {
          filename: "METDesk-2.5.0.exe"
        }
      }
    };

    const pubRes = await fetch(`${baseUrl}/api/release/publish`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": "ci_secret_key"
      },
      body: JSON.stringify(publishPayload)
    });
    expect(pubRes.status).toBe(200);
    const pubData = await pubRes.json();
    expect(pubData.success).toBeTrue();
    expect(pubData.release.version).toBe("2.5.0");
    expect(pubData.release.downloads.windows.url).toContain("/storage/METDesk-2.5.0.exe");

    // 3. Verify /updates returns the newly published version
    const updatesRes = await fetch(`${baseUrl}/updates`);
    const updatesData = await updatesRes.json();
    expect(updatesData.version).toBe("2.5.0");

    // 4. Verify history contains v2.5.0
    const histRes = await fetch(`${baseUrl}/api/release/history`);
    const histData = await histRes.json();
    expect(histData.success).toBeTrue();
    expect(histData.active_version).toBe("2.5.0");
    const v250 = histData.history.find((h: any) => h.version === "2.5.0");
    expect(v250).toBeDefined();

    // 5. Rollback to older version (e.g. 2.2.7)
    const rollbackRes = await fetch(`${baseUrl}/api/release/rollback`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": "ci_secret_key"
      },
      body: JSON.stringify({ version: "2.2.7" })
    });
    expect(rollbackRes.status).toBe(200);
    const rollbackData = await rollbackRes.json();
    expect(rollbackData.success).toBeTrue();
    expect(rollbackData.release.version).toBe("2.2.7");

    // 6. Verify /updates is now rolled back to 2.2.7
    const updatesRolledBack = await fetch(`${baseUrl}/updates`);
    const rolledBackData = await updatesRolledBack.json();
    expect(rolledBackData.version).toBe("2.2.7");
  });
});
