import fs from "node:fs";
import path from "node:path";
import type { ReleaseData } from "../types.ts";
import type { ReleaseStore } from "./types.ts";

export function formatReleaseDate(date: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function getDefaultReleaseTemplate(): ReleaseData {
  return {
    version: "2.3.0",
    type: "minor",
    releaseDate: formatReleaseDate(),
    summary: "Pembaruan UI dan peningkatan performa minor.",
    changelog: [
      {
        type: "feature",
        category: "Baru",
        text: "Integrasi notifikasi desktop untuk seluruh aktivitas"
      },
      {
        type: "improvement",
        category: "Peningkatan",
        text: "Optimasi kecepatan parsing PDF dan memori"
      },
      {
        type: "security",
        category: "Security",
        text: "Pembaruan enkripsi lisensi dan token auth"
      },
      {
        type: "fix",
        category: "Fix",
        text: "Perbaikan sinkronisasi serial number tersimpan"
      }
    ],
    downloads: {
      macos: {
        url: "http://localhost:3001/downloads/METDesk-2.3.0.dmg",
        filename: "METDesk-2.3.0.dmg",
        size: 31457280,
        sizeUnit: "KB"
      },
      windows: {
        url: "http://localhost:3001/downloads/METDesk-2.3.0-setup.exe",
        filename: "METDesk-2.3.0-setup.exe",
        size: 28311552,
        sizeUnit: "KB"
      }
    },
    forceUpdate: false,
    minVersion: "2.0.0"
  };
}

export function getDefaultHistory(activeRelease?: ReleaseData): ReleaseData[] {
  const list: ReleaseData[] = [
    {
      version: "2.2.8",
      type: "patch",
      releaseDate: formatReleaseDate(),
      summary: "Pembaruan arsitektur update server hybrid Cloudflare Workers & R2 dan integrasi CI/CD.",
      changelog: [
        { type: "feature", category: "Baru", text: "Dukungan penuh Cloudflare Workers dan R2 Object Storage untuk preview/dev" },
        { type: "improvement", category: "Peningkatan", text: "Integrasi pipeline CI/CD GitHub Actions dengan pre-computed SHA-256" },
        { type: "security", category: "Security", text: "Validasi ketat ekstensi binary installer desktop (.exe, .dmg, .AppImage)" }
      ],
      downloads: {
        windows: {
          url: "http://localhost:3001/storage/MetDesk_Installer_v2.2.8.exe",
          filename: "MetDesk_Installer_v2.2.8.exe",
          size: 28311552,
          sizeUnit: "KB"
        }
      },
      forceUpdate: false,
      minVersion: "2.0.0"
    },
    {
      version: "2.2.7",
      type: "minor",
      releaseDate: "2026-10-23",
      summary: "Pembaruan UI dan peningkatan performa minor.",
      changelog: [
        { type: "feature", category: "Baru", text: "Integrasi notifikasi desktop untuk seluruh aktivitas" },
        { type: "improvement", category: "Peningkatan", text: "Optimasi kecepatan parsing PDF dan memori" },
        { type: "fix", category: "Fix", text: "Perbaikan sinkronisasi serial number tersimpan" }
      ],
      downloads: {
        macos: {
          url: "http://localhost:3001/downloads/METDesk-2.2.7.dmg",
          filename: "METDesk-2.2.7.dmg",
          size: 31457280,
          sizeUnit: "KB"
        },
        windows: {
          url: "http://localhost:3001/downloads/METDesk-2.2.7-setup.exe",
          filename: "METDesk-2.2.7-setup.exe",
          size: 28311552,
          sizeUnit: "KB"
        }
      },
      forceUpdate: false,
      minVersion: "2.0.0"
    },
    {
      version: "2.2.6",
      type: "patch",
      releaseDate: "2026-10-10",
      summary: "Pembaruan sertifikat keamanan digital dan perbaikan minor.",
      changelog: [
        { type: "security", category: "Security", text: "Pembaruan sertifikat digital Peruri terbaru" },
        { type: "fix", category: "Fix", text: "Perbaikan layout form login pada resolusi layar kecil" }
      ],
      downloads: {},
      forceUpdate: false,
      minVersion: "2.0.0"
    }
  ];

  if (activeRelease) {
    const existingIdx = list.findIndex((r) => r.version === activeRelease.version);
    if (existingIdx !== -1) {
      list[existingIdx] = { ...list[existingIdx], ...activeRelease };
    } else {
      list.unshift(activeRelease);
    }
  }

  return list;
}

export class FileReleaseStore implements ReleaseStore {
  public readonly storeName = "file";
  public readonly filePath: string;
  public readonly draftPath: string;
  public readonly historyPath: string;

  constructor(filePath: string) {
    this.filePath = path.resolve(filePath);
    const dir = path.dirname(this.filePath);
    this.draftPath = path.join(dir, "draft.json");
    this.historyPath = path.join(dir, "history.json");
  }

  getRelease(): ReleaseData {
    if (fs.existsSync(this.filePath)) {
      try {
        const content = fs.readFileSync(this.filePath, "utf-8");
        return JSON.parse(content);
      } catch {}
    }
    return getDefaultReleaseTemplate();
  }

  saveRelease(data: ReleaseData): void {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2) + "\n", "utf-8");
  }

  getDraft(): ReleaseData | null {
    if (fs.existsSync(this.draftPath)) {
      try {
        const content = fs.readFileSync(this.draftPath, "utf-8");
        return JSON.parse(content);
      } catch {}
    }
    return null;
  }

  saveDraft(data: ReleaseData): void {
    const dir = path.dirname(this.draftPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(this.draftPath, JSON.stringify(data, null, 2) + "\n", "utf-8");
  }

  clearDraft(): void {
    if (fs.existsSync(this.draftPath)) {
      try {
        fs.unlinkSync(this.draftPath);
      } catch {}
    }
  }

  getHistory(): ReleaseData[] {
    if (fs.existsSync(this.historyPath)) {
      try {
        const content = fs.readFileSync(this.historyPath, "utf-8");
        const list = JSON.parse(content);
        if (Array.isArray(list) && list.length > 0) {
          return list;
        }
      } catch {}
    }
    const current = this.getRelease();
    const defaults = getDefaultHistory(current);
    this.saveHistory(defaults);
    return defaults;
  }

  saveHistory(history: ReleaseData[]): void {
    const dir = path.dirname(this.historyPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(this.historyPath, JSON.stringify(history, null, 2) + "\n", "utf-8");
  }
}
