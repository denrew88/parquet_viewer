import allowedNames from "./allowedFunctions.json";

// Common signatures, audited against DuckDB 1.5 docs (the bundled engine's series):
// https://duckdb.org/docs/1.5/sql/functions/{aggregates,text,date}
// These are writing hints, not exhaustive overload/type checking.
const common: Record<string, readonly [string, string]> = {
  count: ["COUNT(*) / COUNT(expression)", "Counts rows, or non-NULL input values."],
  sum: ["SUM(expression)", "Adds non-NULL input values. An empty group returns NULL."],
  avg: ["AVG(expression)", "Averages non-NULL input values."],
  min: ["MIN(expression)", "Returns the smallest non-NULL input value."],
  max: ["MAX(expression)", "Returns the largest non-NULL input value."],
  coalesce: ["COALESCE(value, fallback, …)", "Returns the first non-NULL argument."],
  nullif: ["NULLIF(value, other)", "Returns NULL when the two values are equal."],
  ifnull: ["IFNULL(value, fallback)", "Returns the fallback when value is NULL."],
  if: ["IF(condition, when_true, when_false)", "Selects a value using a condition."],
  cast: ["CAST(expression AS type)", "Converts an expression to a target SQL type."],
  try_cast: ["TRY_CAST(expression AS type)", "Returns NULL when conversion fails."],
  abs: ["ABS(value)", "Returns the absolute numeric value."],
  round: ["ROUND(value, precision)", "Rounds a number; precision may be omitted."],
  sqrt: ["SQRT(value)", "Returns the square root."],
  lower: ["LOWER(text)", "Converts text to lowercase."],
  upper: ["UPPER(text)", "Converts text to uppercase."],
  length: ["LENGTH(text)", "Counts characters in text."],
  trim: ["TRIM(text[, characters])", "Removes matching characters at both ends."],
  substring: [
    "SUBSTRING(text, start[, length])",
    "Extracts text using a one-based start position.",
  ],
  replace: ["REPLACE(text, search, replacement)", "Replaces matching text."],
  concat: ["CONCAT(value, …)", "Concatenates values, skipping NULL inputs."],
  concat_ws: [
    "CONCAT_WS(separator, text, …)",
    "Joins text with a separator, skipping NULL inputs.",
  ],
  regexp_replace: [
    "REGEXP_REPLACE(text, pattern, replacement[, options])",
    "Replaces regular-expression matches; option 'g' replaces all matches.",
  ],
  string_agg: [
    "STRING_AGG(expression[, separator])",
    "Joins non-NULL strings; the default separator is a comma.",
  ],
  list: [
    "LIST(expression)",
    "Collects values, including NULLs. Large lists can reach the memory limit.",
  ],
  row_number: ["ROW_NUMBER() OVER (…)", "Numbers rows from one within each window partition."],
  rank: ["RANK() OVER (…)", "Ranks rows with gaps after ties."],
  dense_rank: ["DENSE_RANK() OVER (…)", "Ranks rows without gaps after ties."],
  lag: ["LAG(expression[, offset[, default]]) OVER (…)", "Reads an earlier row in the window."],
  lead: ["LEAD(expression[, offset[, default]]) OVER (…)", "Reads a later row in the window."],
  date_part: ["DATE_PART(part, date_or_timestamp)", "Extracts a date/time component."],
  date_trunc: [
    "DATE_TRUNC(part, date_or_timestamp)",
    "Truncates a date/time value to a chosen precision.",
  ],
  date_diff: ["DATE_DIFF(part, start, end)", "Counts the chosen date/time part boundaries."],
  date_add: ["DATE_ADD(date, interval)", "Adds an interval to a date."],
  strftime: ["STRFTIME(date_or_timestamp, format)", "Formats a date/time value as text."],
  strptime: ["STRPTIME(text, format)", "Parses text using a date/time format."],
  try_strptime: ["TRY_STRPTIME(text, format)", "Parses a date/time, returning NULL on failure."],
};
export const SQL_FUNCTIONS = allowedNames.map((name) => ({
  name: name.toUpperCase(),
  signature: common[name]?.[0] ?? `${name.toUpperCase()}(…)`,
  description:
    common[name]?.[1] ?? "Arguments and supported types depend on the DuckDB function overload.",
}));
