import { describe, expect, it } from "vitest";
import { COPY_PRESETS } from "../copy/presets";
import {
  APP_SETTINGS_SCHEMA_VERSION,
  DEFAULT_DISPLAY_FORMATS,
  DEFAULT_QUERY_TEMP_LIMIT_BYTES,
  InvalidAppSettingsError,
  activeCopyOptions,
  defaultAppSettings,
  parseAppSettings,
  parseAppSettingsJson,
  recoverAppSettings,
} from "./model";

describe("app settings model", () => {
  it("P21 migrates V4 with explicit cache defaults", () => {
    const current = defaultAppSettings();
    const legacy = Object.fromEntries(
      Object.entries(current).filter(
        ([key]) => key !== "csvCacheLimitBytes" && key !== "csvCacheDirectory",
      ),
    );
    const migrated = parseAppSettings({ ...legacy, schemaVersion: 4 });
    expect(migrated.csvCacheLimitBytes).toBe(10 * 1024 ** 3);
    expect(migrated.csvCacheDirectory).toBeNull();
    expect(migrated.schemaVersion).toBe(5);
  });
  it.each([64 * 1024 ** 2, Math.round(0.3 * 1024 ** 3), 10 * 1024 ** 3])(
    "P21 accepts cache cap %s independently of the overall cap",
    (csvCacheLimitBytes) => {
      expect(
        parseAppSettings({
          ...defaultAppSettings(),
          queryTempLimitBytes: 64 * 1024 ** 2,
          csvCacheLimitBytes,
        }).csvCacheLimitBytes,
      ).toBe(csvCacheLimitBytes);
    },
  );
  it.each([
    64 * 1024 ** 2 - 1,
    10 * 1024 ** 3 + 1,
    0,
    1.5,
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
  ])("P21 rejects invalid cache cap %s", (csvCacheLimitBytes) => {
    expect(() => parseAppSettings({ ...defaultAppSettings(), csvCacheLimitBytes })).toThrow(
      "csvCacheLimitBytes",
    );
  });
  it.each([null, "/cache", "C:/cache", "D:\\cache", "\\\\server\\share"])(
    "P21 accepts absolute cache path %s",
    (csvCacheDirectory) => {
      expect(
        parseAppSettings({ ...defaultAppSettings(), csvCacheDirectory }).csvCacheDirectory,
      ).toBe(csvCacheDirectory);
    },
  );
  it.each([
    "",
    "relative/cache",
    "C:relative",
    " C:/cache",
    "C:/cache ",
    "C:/bad\0path",
    "\\\\",
    "/" + "한".repeat(1366),
  ])("P21 rejects invalid cache path %s", (csvCacheDirectory) => {
    expect(() => parseAppSettings({ ...defaultAppSettings(), csvCacheDirectory })).toThrow(
      "csvCacheDirectory",
    );
  });
  it("creates the frozen Phase 9 defaults", () => {
    const settings = defaultAppSettings();

    expect(settings).toEqual({
      schemaVersion: APP_SETTINGS_SCHEMA_VERSION,
      copyPreset: "excel",
      copyCustomOptions: COPY_PRESETS.custom,
      csvDefaultParsingMode: "auto",
      queryTempLimitBytes: 10 * 1024 * 1024 * 1024,
      csvCacheLimitBytes: 10 * 1024 * 1024 * 1024,
      csvCacheDirectory: null,
      copyLimits: {
        maxCells: 1_000_000,
        maxBytes: 64 * 1024 * 1024,
      },
      displayFormats: DEFAULT_DISPLAY_FORMATS,
    });
    expect(settings.queryTempLimitBytes).toBe(DEFAULT_QUERY_TEMP_LIMIT_BYTES);
    expect(activeCopyOptions(settings)).toEqual(COPY_PRESETS.excel);
    expect(Object.isFrozen(settings)).toBe(true);
    expect(Object.isFrozen(settings.copyCustomOptions)).toBe(true);
    expect(Object.isFrozen(settings.copyLimits)).toBe(true);
  });

  it("strictly parses a valid settings object and JSON round-trip", () => {
    const input = {
      ...defaultAppSettings(),
      copyPreset: "custom",
      copyCustomOptions: {
        ...COPY_PRESETS.custom,
        delimiter: "🧪",
        includeHeaders: true,
        dateTimeRepresentation: { mode: "custom", format: "YYYY/MM/DD" },
      },
      csvDefaultParsingMode: "askEveryTime",
    };

    const parsed = parseAppSettings(input);
    expect(parsed.copyPreset).toBe("custom");
    expect(activeCopyOptions(parsed).delimiter).toBe("🧪");
    expect(parseAppSettingsJson(JSON.stringify(input))).toEqual(parsed);
  });

  it.each([
    ["unknown root key", { ...defaultAppSettings(), future: true }],
    ["wrong schema", { ...defaultAppSettings(), schemaVersion: 99 }],
    ["unknown preset", { ...defaultAppSettings(), copyPreset: "database" }],
    ["unknown CSV mode", { ...defaultAppSettings(), csvDefaultParsingMode: "guess" }],
    ["fractional temp limit", { ...defaultAppSettings(), queryTempLimitBytes: 1.5 }],
    [
      "copy cell limit below minimum",
      { ...defaultAppSettings(), copyLimits: { maxCells: 999, maxBytes: 64 * 1024 * 1024 } },
    ],
    [
      "copy byte limit above maximum",
      {
        ...defaultAppSettings(),
        copyLimits: { maxCells: 1_000_000, maxBytes: 256 * 1024 * 1024 + 1 },
      },
    ],
    [
      "unknown copy limit key",
      {
        ...defaultAppSettings(),
        copyLimits: { ...defaultAppSettings().copyLimits, unlimited: true },
      },
    ],
    ["non-Custom custom options", { ...defaultAppSettings(), copyCustomOptions: COPY_PRESETS.csv }],
    [
      "unknown nested key",
      {
        ...defaultAppSettings(),
        copyCustomOptions: { ...COPY_PRESETS.custom, encoding: "utf-8" },
      },
    ],
    [
      "invalid delimiter",
      { ...defaultAppSettings(), copyCustomOptions: { ...COPY_PRESETS.custom, delimiter: "::" } },
    ],
  ])("rejects %s", (_name, input) => {
    expect(() => parseAppSettings(input)).toThrow(InvalidAppSettingsError);
  });

  it("reports malformed JSON as typed invalid settings", () => {
    expect(() => parseAppSettingsJson('{"schemaVersion":')).toThrow(InvalidAppSettingsError);
  });

  it("migrates a strictly valid V1 object to V2 copy-limit defaults", () => {
    const current = defaultAppSettings();
    const v1 = {
      schemaVersion: 1,
      copyPreset: current.copyPreset,
      copyCustomOptions: current.copyCustomOptions,
      csvDefaultParsingMode: current.csvDefaultParsingMode,
      queryTempLimitBytes: current.queryTempLimitBytes,
    };

    expect(parseAppSettings(v1)).toEqual(current);
    expect(recoverAppSettings(v1)).toEqual({ settings: current, warning: null });
    expect(() => parseAppSettings({ ...v1, future: true })).toThrow(InvalidAppSettingsError);
  });

  it("migrates V3 timestamp precision into the V4 timestamp and duration defaults", () => {
    const current = defaultAppSettings();
    const legacyFormats = Object.fromEntries(
      Object.entries(current.displayFormats).filter(
        ([key]) => key !== "duration" && key !== "timestamp",
      ),
    );
    const v3 = {
      ...Object.fromEntries(
        Object.entries(current).filter(
          ([key]) => key !== "csvCacheLimitBytes" && key !== "csvCacheDirectory",
        ),
      ),
      schemaVersion: 3,
      displayFormats: {
        ...legacyFormats,
        timestamp: { fractionalDigits: { mode: "fixed", digits: 6 } },
      },
    };

    const migrated = parseAppSettings(v3);
    expect(migrated.schemaVersion).toBe(APP_SETTINGS_SCHEMA_VERSION);
    expect(migrated.displayFormats.timestamp).toEqual({
      ...DEFAULT_DISPLAY_FORMATS.timestamp,
      fractionalDigits: { mode: "fixed", digits: 6 },
    });
    expect(migrated.displayFormats.duration).toEqual(DEFAULT_DISPLAY_FORMATS.duration);
  });

  it.each([
    ["timestamp date", { timestamp: { dateFormat: "YY-MM-DD" } }],
    ["timestamp fraction", { timestamp: { fractionalDigits: { mode: "fixed", digits: 10 } } }],
    ["duration style", { duration: { style: "clock" } }],
  ])("rejects an invalid V4 %s setting", (_name, override) => {
    const defaults = defaultAppSettings();
    const timestamp = {
      ...defaults.displayFormats.timestamp,
      ...("timestamp" in override ? override.timestamp : {}),
    };
    const duration = {
      ...defaults.displayFormats.duration,
      ...("duration" in override ? override.duration : {}),
    };
    expect(() =>
      parseAppSettings({
        ...defaults,
        displayFormats: { ...defaults.displayFormats, timestamp, duration },
      }),
    ).toThrow(InvalidAppSettingsError);
  });

  it("accepts inclusive copy-limit boundaries", () => {
    expect(
      parseAppSettings({
        ...defaultAppSettings(),
        copyLimits: { maxCells: 1_000, maxBytes: 1024 * 1024 },
      }).copyLimits,
    ).toEqual({ maxCells: 1_000, maxBytes: 1024 * 1024 });
    expect(
      parseAppSettings({
        ...defaultAppSettings(),
        copyLimits: { maxCells: 10_000_000, maxBytes: 256 * 1024 * 1024 },
      }).copyLimits,
    ).toEqual({ maxCells: 10_000_000, maxBytes: 256 * 1024 * 1024 });
  });

  it("recovers corruption to a fresh default without mutating the input", () => {
    const corrupt = { ...defaultAppSettings(), queryTempLimitBytes: -1 };
    const recovered = recoverAppSettings(corrupt);

    expect(recovered.settings).toEqual(defaultAppSettings());
    expect(recovered.settings).not.toBe(defaultAppSettings());
    expect(recovered.warning).toBeInstanceOf(InvalidAppSettingsError);
    expect(corrupt.queryTempLimitBytes).toBe(-1);
  });
});
