/**
 * Cloudflare Workers Entry Point for METDesk Update Server.
 * Used for Development & Preview environments with Cloudflare R2 bucket storage.
 */

// @ts-ignore
import adminHtmlText from "../admin.html";
import { handleUpdateRequest } from "./handler.ts";
import { R2ReleaseStore } from "./release/r2.ts";
import { R2StorageProvider } from "./storage/r2.ts";

export interface WorkerEnv {
  BINARIES_BUCKET: any;
  ADMIN_USERNAME?: string;
  ADMIN_PASSWORD?: string;
  UPLOAD_AUTH_KEY?: string;
}

export default {
  async fetch(req: Request, env: WorkerEnv, _ctx?: any): Promise<Response> {
    if (!env.BINARIES_BUCKET) {
      return new Response(
        "R2 Bucket binding 'BINARIES_BUCKET' is not configured in wrangler.toml or Cloudflare dashboard.",
        { status: 500, headers: { "Content-Type": "text/plain" } }
      );
    }

    const storage = new R2StorageProvider(env.BINARIES_BUCKET, env.UPLOAD_AUTH_KEY || "");
    const release = new R2ReleaseStore(env.BINARIES_BUCKET, "release.json");

    return handleUpdateRequest(req, {
      storage,
      release,
      adminHtml: () => adminHtmlText,
      adminUsername: env.ADMIN_USERNAME || "admin",
      adminPassword: env.ADMIN_PASSWORD !== undefined ? env.ADMIN_PASSWORD : "admin123",
      uploadAuthKey: env.UPLOAD_AUTH_KEY || ""
    });
  }
};
