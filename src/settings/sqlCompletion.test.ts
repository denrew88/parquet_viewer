import { describe, expect, it } from "vitest";
import boundaries from "../../fixtures/phase-22/sql-completion-settings-boundaries.json";
import { defaultAppSettings, parseAppSettings, recoverAppSettings } from "./model";

describe("SQL completion settings shared boundary corpus", () => {
  it.each(boundaries.cases)("wire $name", (item) => {
    const wire: Record<string, unknown> = { ...defaultAppSettings() };
    if ("mode" in item) wire.sqlCompletionMode = item.mode;
    else delete wire.sqlCompletionMode;
    if (item.valid) expect(parseAppSettings(wire).sqlCompletionMode).toBe(item.mode);
    else expect(() => parseAppSettings(wire)).toThrow("sqlCompletionMode");
  });
  it("migrates V6 without resetting non-completion settings", () => {
    const original = {
      ...defaultAppSettings(),
      sqlTempLimitBytes: 322122547,
      csvCacheDirectory: "D:/retained-cache",
      csvDefaultParsingMode: "allText" as const,
    };
    const wire: Record<string, unknown> = { ...original, schemaVersion: 6 };
    delete wire.sqlCompletionMode;
    expect(parseAppSettings(wire)).toEqual({
      ...original,
      schemaVersion: 7,
      sqlCompletionMode: "contextual",
    });
    expect(() => parseAppSettings({ ...wire, sqlCompletionMode: "manual" })).toThrow();
  });
  it("recovers invalid current mode through existing recovery", () => {
    const recovered = recoverAppSettings({ ...defaultAppSettings(), sqlCompletionMode: "wrong" });
    expect(recovered.warning).not.toBeNull();
    expect(recovered.settings.sqlCompletionMode).toBe("contextual");
  });
});
