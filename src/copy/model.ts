export type CopyPreset = "excel" | "tsv" | "csv" | "custom";

export type CopyQuoteMode = "minimal" | "always" | "none";
export type CopyEscapeMode = "double" | "backslash";
export type CopyLineEnding = "crlf" | "lf";
export type EmptyStringRepresentation = "empty" | "quoted-empty";
export type BooleanRepresentation = "lowercase" | "uppercase" | "numeric";

export type DateTimeRepresentation =
  | { readonly mode: "display" }
  | { readonly mode: "iso8601" }
  | { readonly mode: "custom"; readonly format: string };

export interface CopyOptions {
  readonly preset: CopyPreset;
  readonly delimiter: string;
  readonly includeHeaders: boolean;
  readonly quoteMode: CopyQuoteMode;
  readonly quoteCharacter: string;
  readonly escapeMode: CopyEscapeMode;
  readonly lineEnding: CopyLineEnding;
  readonly nullRepresentation: string;
  readonly emptyStringRepresentation: EmptyStringRepresentation;
  readonly booleanRepresentation: BooleanRepresentation;
  readonly dateTimeRepresentation: DateTimeRepresentation;
}

export type CopyValidationCode =
  | "InvalidDelimiter"
  | "InvalidQuoteCharacter"
  | "AmbiguousDelimiterAndQuote"
  | "InvalidDateTimeFormat";

export interface CopyValidationIssue {
  readonly code: CopyValidationCode;
  readonly message: string;
  readonly field: "delimiter" | "quoteCharacter" | "dateTimeRepresentation";
}

export type CopyWarningCode = "NullEmptyDistinctionLost";

export interface CopyWarning {
  readonly code: CopyWarningCode;
  readonly message: string;
}

export class InvalidCopyOptionsError extends Error {
  readonly code = "InvalidCopyOptions";
  readonly issues: readonly CopyValidationIssue[];

  constructor(issues: readonly CopyValidationIssue[]) {
    super(issues.map((issue) => issue.message).join(" "));
    this.name = "InvalidCopyOptionsError";
    this.issues = issues;
  }
}

function isOneUnicodeCharacter(value: string): boolean {
  return [...value].length === 1;
}

function invalidStructuralCharacter(value: string): boolean {
  return value === "\r" || value === "\n" || value === "\0";
}

export function validateCopyOptions(options: CopyOptions): CopyValidationIssue[] {
  const issues: CopyValidationIssue[] = [];
  if (!isOneUnicodeCharacter(options.delimiter) || invalidStructuralCharacter(options.delimiter)) {
    issues.push({
      code: "InvalidDelimiter",
      field: "delimiter",
      message: "Delimiter must be one Unicode character and cannot be CR, LF, or NUL.",
    });
  }
  if (
    !isOneUnicodeCharacter(options.quoteCharacter) ||
    invalidStructuralCharacter(options.quoteCharacter)
  ) {
    issues.push({
      code: "InvalidQuoteCharacter",
      field: "quoteCharacter",
      message: "Quote character must be one Unicode character and cannot be CR, LF, or NUL.",
    });
  }
  if (
    isOneUnicodeCharacter(options.delimiter) &&
    isOneUnicodeCharacter(options.quoteCharacter) &&
    options.delimiter === options.quoteCharacter
  ) {
    issues.push({
      code: "AmbiguousDelimiterAndQuote",
      field: "quoteCharacter",
      message: "Delimiter and quote character must be different.",
    });
  }
  if (
    options.dateTimeRepresentation.mode === "custom" &&
    options.dateTimeRepresentation.format.trim() === ""
  ) {
    issues.push({
      code: "InvalidDateTimeFormat",
      field: "dateTimeRepresentation",
      message: "Custom date/time format cannot be empty.",
    });
  }
  return issues;
}

export function assertValidCopyOptions(options: CopyOptions): void {
  const issues = validateCopyOptions(options);
  if (issues.length > 0) throw new InvalidCopyOptionsError(issues);
}

export function copyOptionWarnings(options: CopyOptions): CopyWarning[] {
  return options.nullRepresentation === "" && options.emptyStringRepresentation === "empty"
    ? [
        {
          code: "NullEmptyDistinctionLost",
          message: "Null and empty strings are both copied as empty fields.",
        },
      ]
    : [];
}

export function snapshotCopyOptions(options: CopyOptions): CopyOptions {
  const dateTimeRepresentation = Object.freeze({ ...options.dateTimeRepresentation });
  return Object.freeze({ ...options, dateTimeRepresentation });
}
