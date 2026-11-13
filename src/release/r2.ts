import type { ReleaseData } from "../types.ts";
import type { R2BucketLike } from "../storage/r2.ts";
import type { ReleaseStore } from "./types.ts";
import { getDefaultHistory, getDefaultReleaseTemplate } from "./file.ts";

export class R2ReleaseStore implements ReleaseStore {
  public readonly storeName = "r2";
  public readonly bucket: R2BucketLike;
  public readonly objectKey: string;
  public readonly draftKey: string;
  public readonly historyKey: string;

  constructor(
    bucket: R2BucketLike,
    objectKey: string = "release.json",
    draftKey: string = "draft.json",
    historyKey: string = "history.json"
  ) {
    this.bucket = bucket;
    this.objectKey = objectKey;
    this.draftKey = draftKey;
    this.historyKey = historyKey;
  }

  async getRelease(): Promise<ReleaseData> {
    try {
      const obj = await this.bucket.get(this.objectKey);
      if (obj) {
        const text = await obj.text();
        return JSON.parse(text);
      }
    } catch (err) {
      console.warn(`[R2-RELEASE] Could not read ${this.objectKey} from R2, using default template:`, err);
    }
    return getDefaultReleaseTemplate();
  }

  async saveRelease(data: ReleaseData): Promise<void> {
    const jsonStr = JSON.stringify(data, null, 2) + "\n";
    await this.bucket.put(this.objectKey, jsonStr, {
      httpMetadata: {
        contentType: "application/json; charset=utf-8"
      }
    });
    console.log(`[R2-RELEASE] Saved updated ${this.objectKey} to R2 bucket`);
  }

  async getDraft(): Promise<ReleaseData | null> {
    try {
      const obj = await this.bucket.get(this.draftKey);
      if (obj) {
        const text = await obj.text();
        return JSON.parse(text);
      }
    } catch (err) {
      console.warn(`[R2-DRAFT] Could not read ${this.draftKey}:`, err);
    }
    return null;
  }

  async saveDraft(data: ReleaseData): Promise<void> {
    const jsonStr = JSON.stringify(data, null, 2) + "\n";
    await this.bucket.put(this.draftKey, jsonStr, {
      httpMetadata: {
        contentType: "application/json; charset=utf-8"
      }
    });
    console.log(`[R2-DRAFT] Saved draft to ${this.draftKey}`);
  }

  async clearDraft(): Promise<void> {
    try {
      await this.bucket.delete(this.draftKey);
      console.log(`[R2-DRAFT] Cleared ${this.draftKey}`);
    } catch {}
  }

  async getHistory(): Promise<ReleaseData[]> {
    try {
      const obj = await this.bucket.get(this.historyKey);
      if (obj) {
        const text = await obj.text();
        const list = JSON.parse(text);
        if (Array.isArray(list) && list.length > 0) {
          return list;
        }
      }
    } catch (err) {
      console.warn(`[R2-HISTORY] Could not read ${this.historyKey}:`, err);
    }
    const current = await this.getRelease();
    const defaults = getDefaultHistory(current);
    await this.saveHistory(defaults);
    return defaults;
  }

  async saveHistory(history: ReleaseData[]): Promise<void> {
    const jsonStr = JSON.stringify(history, null, 2) + "\n";
    await this.bucket.put(this.historyKey, jsonStr, {
      httpMetadata: {
        contentType: "application/json; charset=utf-8"
      }
    });
    console.log(`[R2-HISTORY] Saved release history (${history.length} versions) to ${this.historyKey}`);
  }
}
