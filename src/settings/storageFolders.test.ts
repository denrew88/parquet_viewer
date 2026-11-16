import { describe, expect, it } from "vitest";
import kinds from "../../fixtures/phase-25/storage-folder-kinds.json";
import { isStorageFolderKind, parseStorageLocations } from "./storageFolders";

const valid = {
  csvCache: { path: "D:\\Data Viewer Cache\\한글, cache", available: true },
  queryTemp: { path: "C:\\App Data\\query-temp", available: false },
};

describe("managed storage folder contract", () => {
  it.each(kinds)("shares native kind validity for $value", ({ value, valid }) => {
    expect(isStorageFolderKind(value)).toBe(valid);
  });

  it("preserves distinct literal paths and independent availability", () => {
    const parsed = parseStorageLocations(valid);
    expect(parsed).toEqual(valid);
    expect(parsed.csvCache).not.toBe(valid.csvCache);
    expect(parsed.queryTemp).not.toBe(valid.queryTemp);
  });

  it.each([
    null,
    [],
    { csvCache: valid.csvCache },
    { ...valid, extra: "C:\\private" },
    { ...valid, queryTemp: { path: "", available: false } },
    { ...valid, queryTemp: { path: "C:\\private\0", available: true } },
    { ...valid, csvCache: { ...valid.csvCache, available: 1 } },
    { ...valid, csvCache: { ...valid.csvCache, extra: true } },
  ])("rejects invalid folder responses without substituting another path: %j", (value) => {
    expect(() => parseStorageLocations(value)).toThrow("Storage locations could not be read.");
  });
});
