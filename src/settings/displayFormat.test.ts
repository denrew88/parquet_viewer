import { describe, expect, it } from "vitest";
import type { DataValue } from "../backend";
import { formatDataValue } from "./displayFormat";
import { defaultAppSettings } from "./model";

function value(kind: DataValue["kind"], display: string): DataValue {
  return { kind, display, state: display === "" ? "empty" : "valid", rawDisplay: null };
}

describe("global display formatting", () => {
  it("uses the compact timezone-free timestamp contract by default", () => {
    expect(
      formatDataValue(
        value("timestamp", "2025-12-18T01:23:34.111111111Z [unit=ns]"),
        defaultAppSettings().displayFormats,
      ),
    ).toMatchObject({
      display: "2025-12-18 01:23:34.111111111",
      rawDisplay: "2025-12-18T01:23:34.111111111Z [unit=ns]",
    });
  });

  it("formats integer, decimal, boolean, and string display without changing raw text", () => {
    const defaults = defaultAppSettings().displayFormats;
    const formats = {
      ...defaults,
      integer: { grouping: "comma" as const },
      decimal: { grouping: "comma" as const, scale: { mode: "fixed" as const, digits: 2 } },
      boolean: { representation: "uppercase" as const },
      string: { ...defaults.string, renderLineBreaks: false },
    };
    expect(formatDataValue(value("int", "1234567"), formats)).toMatchObject({
      display: "1,234,567",
      rawDisplay: "1234567",
    });
    expect(formatDataValue(value("decimal", "1234567.8"), formats).display).toBe("1,234,567.80");
    expect(formatDataValue(value("boolean", "true"), formats).display).toBe("TRUE");
    expect(formatDataValue(value("string", "first\nsecond"), formats).display).toBe(
      "first\\nsecond",
    );
  });

  it("limits binary previews while retaining the original payload", () => {
    const defaults = defaultAppSettings().displayFormats;
    const formatted = formatDataValue(value("binary", "base64:AQIDBA== (4 bytes)"), {
      ...defaults,
      binary: { encoding: "hex", previewBytes: 2 },
    });
    expect(formatted.display).toBe("hex:0102… (4 bytes)");
    expect(formatted.rawDisplay).toBe("base64:AQIDBA== (4 bytes)");
  });

  it("marks a backend-bounded binary payload as truncated from its declared length", () => {
    const formatted = formatDataValue(value("binary", "base64:AQIDBA== (4096 bytes)"), {
      ...defaultAppSettings().displayFormats,
      binary: { encoding: "hex", previewBytes: 32 },
    });
    expect(formatted.display).toBe("hex:01020304… (4096 bytes)");
  });
});
