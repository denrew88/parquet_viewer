import { describe, expect, it } from "vitest";
import { COPY_PRESETS } from "../copy/presets";
import {
  APP_SETTINGS_SCHEMA_VERSION,
  DEFAULT_QUERY_TEMP_LIMIT_BYTES,
  InvalidAppSettingsError,
  activeCopyOptions,
  defaultAppSettings,
  parseAppSettings,
  parseAppSettingsJson,
  recoverAppSettings,
} from "./model";

describe("app settings model", () => {
  it("creates the frozen Phase 9 defaults", () => {
    const settings = defaultAppSettings();

    expect(settings).toEqual({
      schemaVersion: APP_SETTINGS_SCHEMA_VERSION,
      copyPreset: "excel",
      copyCustomOptions: COPY_PRESETS.custom,
      csvDefaultParsingMode: "auto",
      queryTempLimitBytes: 10 * 1024 * 1024 * 1024,
      copyLimits: {
        maxCells: 1_000_000,
        maxBytes: 64 * 1024 * 1024,
      },
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
    ["wrong schema", { ...defaultAppSettings(), schemaVersion: 3 }],
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
