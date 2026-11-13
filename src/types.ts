export interface ChangelogItem {
  type: "feature" | "improvement" | "security" | "fix" | string;
  category: string;
  text: string;
}

export interface PlatformDownload {
  url: string;
  filename: string;
  size?: number;
  sizeBytes?: number;
  sizeUnit?: string;
  sha256?: string;
}

export interface ReleaseData {
  version: string;
  type?: string;
  releaseDate?: string;
  summary?: string;
  changelog?: ChangelogItem[];
  downloads: {
    macos?: PlatformDownload;
    windows?: PlatformDownload;
    linux?: PlatformDownload;
    [key: string]: PlatformDownload | undefined;
  };
  forceUpdate?: boolean;
  minVersion?: string;
  [key: string]: any;
}

export interface StoredObject {
  key: string;
  name: string;
  filename?: string;
  size_bytes: number;
  size_formatted: string;
  size_mb: number;
  sha256: string;
  etag?: string;
  content_type: string;
  modified?: string;
  url?: string;
  path?: string;
  download_url?: string;
  release_updated?: boolean;
  is_active_macos?: boolean;
  is_active_windows?: boolean;
  active_release?: string | null;
}

export interface StorageStats {
  storage_dir: string;
  total_objects: number;
  total_bytes: number;
  total_formatted: string;
  macos_count: number;
  windows_count: number;
  linux_count?: number;
  archive_count: number;
  other_count: number;
}

export interface SessionInfo {
  username: string;
  createdAt: number;
}
