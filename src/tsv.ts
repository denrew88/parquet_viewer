import type { DataValue } from "./backend";

export const COPY_SOFT_CELL_LIMIT = 100_000;
export const COPY_HARD_CELL_LIMIT = 1_000_000;
export const COPY_SOFT_BYTE_LIMIT = 8 * 1024 * 1024;
export const COPY_HARD_BYTE_LIMIT = 64 * 1024 * 1024;
export const COPY_CHUNK_ROWS = 200;

export class CopyLimitExceededError extends Error {
  readonly code = "CopyLimitExceeded";

  constructor(message: string) {
    super(message);
    this.name = "CopyLimitExceededError";
  }
}

function quoteField(text: string, forceQuote = false): string {
  if (forceQuote || /[\t\r\n"]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

export function serializeTsvField(value: DataValue): string {
  if (value.kind === "null" || value.display === null) return "";
  return quoteField(value.display, value.kind === "string" && value.display === "");
}

export function serializeTsv(
  rows: readonly (readonly DataValue[])[],
  headers?: readonly string[],
): string {
  const lines: string[] = [];
  if (headers) lines.push(headers.map((header) => quoteField(header, header === "")).join("\t"));
  for (const row of rows) lines.push(row.map(serializeTsvField).join("\t"));
  return lines.join("\r\n");
}

export class TsvAccumulator {
  private readonly parts: string[] = [];
  private byteLengthValue = 0;
  private hasLine = false;

  get byteLength(): number {
    return this.byteLengthValue;
  }

  appendRows(rows: readonly (readonly DataValue[])[], headers?: readonly string[]): void {
    const chunk = serializeTsv(rows, headers);
    if (chunk === "") return;
    const prefix = this.hasLine ? "\r\n" : "";
    const bytes = new TextEncoder().encode(prefix + chunk).byteLength;
    if (this.byteLengthValue + bytes > COPY_HARD_BYTE_LIMIT) {
      throw new CopyLimitExceededError("The selection exceeds the 64 MiB clipboard limit.");
    }
    this.parts.push(prefix, chunk);
    this.byteLengthValue += bytes;
    this.hasLine = true;
  }

  finish(): string {
    return this.parts.join("");
  }
}
