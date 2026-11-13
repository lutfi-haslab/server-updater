import type { ReleaseData } from "../types.ts";

export interface ReleaseStore {
  readonly storeName: string;
  getRelease(): Promise<ReleaseData> | ReleaseData;
  saveRelease(data: ReleaseData): Promise<void> | void;
  getDraft(): Promise<ReleaseData | null> | ReleaseData | null;
  saveDraft(data: ReleaseData): Promise<void> | void;
  clearDraft(): Promise<void> | void;
  getHistory(): Promise<ReleaseData[]> | ReleaseData[];
  saveHistory(history: ReleaseData[]): Promise<void> | void;
}
