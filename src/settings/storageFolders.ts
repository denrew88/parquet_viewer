export type StorageFolderKind = "csvCache" | "queryTemp";

export interface StorageFolderLocation {
  path: string;
  available: boolean;
}

export interface StorageLocations {
  csvCache: StorageFolderLocation;
  queryTemp: StorageFolderLocation;
}

export interface StorageFolderBackend {
  getLocations(): Promise<StorageLocations>;
  openFolder(kind: StorageFolderKind): Promise<void>;
}

export function isStorageFolderKind(value: unknown): value is StorageFolderKind {
  return value === "csvCache" || value === "queryTemp";
}

export function parseStorageLocations(value: unknown): StorageLocations {
  const record = (item: unknown, keys: readonly string[]): item is Record<string, unknown> =>
    typeof item === "object" &&
    item !== null &&
    !Array.isArray(item) &&
    Object.keys(item).length === keys.length &&
    keys.every((key) => Object.prototype.hasOwnProperty.call(item, key));
  const location = (item: unknown): item is StorageFolderLocation =>
    record(item, ["path", "available"]) &&
    typeof item.path === "string" &&
    item.path.trim().length > 0 &&
    !item.path.includes("\0") &&
    typeof item.available === "boolean";
  if (
    !record(value, ["csvCache", "queryTemp"]) ||
    !location(value.csvCache) ||
    !location(value.queryTemp)
  )
    throw new Error("Storage locations could not be read.");
  return {
    csvCache: { ...value.csvCache },
    queryTemp: { ...value.queryTemp },
  };
}
