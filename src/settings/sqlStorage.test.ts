import { describe, expect, it } from "vitest";
import cases from "../../fixtures/phase-22/sql-storage-boundaries.json";
import {
  defaultAppSettings,
  parseAppSettings,
  parseStorageGiB,
  DEFAULT_DISPLAY_FORMATS,
} from "./model";

describe("SQL storage shared boundary corpus", () => {
  it.each(cases.byteCases)("wire $id", (item) => {
    const input: Record<string, unknown> = { ...defaultAppSettings() };
    if ("value" in item) input.sqlTempLimitBytes = item.value;
    else delete input.sqlTempLimitBytes;
    if (item.valid) expect(parseAppSettings(input).sqlTempLimitBytes).toBe(item.value);
    else expect(() => parseAppSettings(input)).toThrow("sqlTempLimitBytes");
  });
  it.each(cases.uiCases)("GiB '$text'", (item) => {
    expect(parseStorageGiB(item.text)).toBe(item.valid && "bytes" in item ? item.bytes : null);
  });
  it.each(cases.legacyVersions)("migrates V%s without resetting historical fields", (version) => {
    const current = defaultAppSettings();
    const input: Record<string, unknown> = {
      ...current,
      schemaVersion: version,
      queryTempLimitBytes: 322122547,
      csvDefaultParsingMode: "allText",
    };
    delete input.sqlTempLimitBytes;
    delete input.sqlCompletionMode;
    if (version < 5) {
      delete input.csvCacheDirectory;
      delete input.csvCacheLimitBytes;
    } else {
      input.csvCacheDirectory = "D:/retained-cache";
      input.csvCacheLimitBytes = 67108864;
    }
    if (version < 3) delete input.displayFormats;
    if (version === 3) {
      const formats = Object.fromEntries(
        Object.entries(DEFAULT_DISPLAY_FORMATS).filter(
          ([key]) => key !== "duration" && key !== "timestamp",
        ),
      );
      input.displayFormats = { ...formats, timestamp: { fractionalDigits: { mode: "preserve" } } };
    }
    if (version === 1) delete input.copyLimits;
    const migrated = parseAppSettings(input);
    expect(migrated.sqlTempLimitBytes).toBe(cases.defaultBytes);
    expect(migrated.schemaVersion).toBe(cases.currentVersion);
    expect(migrated.queryTempLimitBytes).toBe(322122547);
    expect(migrated.csvDefaultParsingMode).toBe("allText");
    if (version === 5) {
      expect(migrated.csvCacheDirectory).toBe("D:/retained-cache");
      expect(migrated.csvCacheLimitBytes).toBe(67108864);
    }
  });
});
