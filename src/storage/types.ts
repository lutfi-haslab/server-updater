import type { StorageStats, StoredObject } from "../types.ts";

export interface DownloadResult {
  stream: ReadableStream<Uint8Array> | Blob | Uint8Array;
  size: number;
  contentType: string;
  etag: string;
  range?: {
    start: number;
    end: number;
    total: number;
  };
}

export interface StorageProvider {
  readonly storageName: string;

  putObject(
    key: string,
    stream:
      | ReadableStream<Uint8Array>
      | AsyncIterable<Uint8Array>
      | Uint8Array
      | Buffer
      | NodeJS.ReadableStream,
    sizeBytes?: number,
    contentType?: string
  ): Promise<StoredObject>;

  downloadObject(
    key: string,
    rangeHeader?: string | null
  ): Promise<DownloadResult | { status: 416; totalSize: number } | null>;

  headObject(key: string): Promise<StoredObject | null> | StoredObject | null;

  deleteObject(key: string): Promise<boolean> | boolean;

  renameObject(oldKey: string, newKey: string): Promise<StoredObject | null> | StoredObject | null;

  listObjects(serverBaseUrl: string): Promise<StoredObject[]> | StoredObject[];

  getStats(): Promise<StorageStats> | StorageStats;

  isAuthValid(authHeader?: string | null, apiKeyHeader?: string | null): boolean;
}
