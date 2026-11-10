import { foldSqlIdentifier, SQL_MAX_BYTES, trimSqlWhitespace } from "./backend";
import { sqlIdentifier, sqlColumnName, type SqlTable } from "./model";
import { SQL_FUNCTIONS } from "./functionCatalog";
import { bindingsFor, identifier, keyword, type Binding, type Token } from "./completionRelations";

export const MAX_COMPLETION_OPTIONS = 200;
const MAX_TOKENS = 8192;
export const SQL_COMPLETION_KEYWORDS = [
  "SELECT",
  "FROM",
  "WHERE",
  "JOIN",
  "LEFT",
  "RIGHT",
  "INNER",
  "OUTER",
  "FULL",
  "CROSS",
  "ON",
  "AS",
  "WITH",
  "GROUP BY",
  "ORDER BY",
  "HAVING",
  "QUALIFY",
  "LIMIT",
  "OFFSET",
  "ASC",
  "DESC",
  "NULL",
  "IS",
  "NOT",
  "AND",
  "OR",
  "CASE",
  "WHEN",
  "THEN",
  "ELSE",
  "END",
  "DISTINCT",
  "UNION ALL",
  "OVER",
  "PARTITION BY",
  "FILTER",
  "EXCLUDE",
  "REPLACE",
  "BIGINT",
  "VARCHAR",
  "DECIMAL",
  "TIMESTAMP",
  "DATE",
];
export interface SqlCompletionOption {
  label: string;
  insertText: string;
  type: "table" | "property" | "function" | "keyword" | "join";
  detail?: string;
  info?: string;
  infoDetails?: string;
  boost?: number;
  manualOnly?: boolean;
}
export interface SqlCompletionResult {
  from: number;
  to: number;
  options: SqlCompletionOption[];
}
export interface SqlFunctionHint {
  name: string;
  signature: string;
  description: string;
  argumentIndex: number;
  from: number;
  to: number;
}
const key = foldSqlIdentifier;

function lex(doc: string, bounded = true) {
  if (
    bounded &&
    (doc.length > SQL_MAX_BYTES || new TextEncoder().encode(doc).length > SQL_MAX_BYTES)
  )
    return null;
  const tokens: Token[] = [],
    stack: number[] = [],
    ends = new Map<number, number>();
  for (let i = 0; i < doc.length;) {
    if (/\s/u.test(doc[i])) {
      i++;
      continue;
    }
    if (bounded && tokens.length >= MAX_TOKENS) return null;
    const from = i;
    let kind: Token["kind"] = "symbol",
      value = "",
      closed = true;
    if (doc.startsWith("--", i)) {
      kind = "comment";
      const end = doc.indexOf("\n", i);
      i = end < 0 ? doc.length : end;
      closed = end >= 0;
    } else if (doc.startsWith("/*", i)) {
      kind = "comment";
      let nesting = 1;
      i += 2;
      while (i < doc.length && nesting) {
        if (doc.startsWith("/*", i)) {
          nesting++;
          i += 2;
        } else if (doc.startsWith("*/", i)) {
          nesting--;
          i += 2;
        } else i++;
      }
      closed = nesting === 0;
    } else if (doc[i] === "'" || doc[i] === '"') {
      const quote = doc[i++];
      kind = quote === "'" ? "string" : "quoted";
      closed = false;
      while (i < doc.length) {
        if (doc[i] === quote) {
          if (doc[i + 1] === quote) {
            value += quote;
            i += 2;
          } else {
            i++;
            closed = true;
            break;
          }
        } else if (kind === "string" && doc[i] === "\\" && /[eE]/.test(doc[from - 1] ?? "")) {
          value += doc.slice(i, i + 2);
          i += 2;
        } else value += doc[i++];
      }
    } else {
      const dollar =
        doc[i] === "$" ? doc.slice(i).match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/)?.[0] : undefined;
      if (dollar) {
        kind = "string";
        const end = doc.indexOf(dollar, i + dollar.length);
        i = end < 0 ? doc.length : end + dollar.length;
        closed = end >= 0;
      } else if (/[\p{L}\p{N}\p{M}_$]/u.test(doc[i])) {
        kind = "word";
        while (i < doc.length && /[\p{L}\p{N}\p{M}_$]/u.test(doc[i])) value += doc[i++];
      } else {
        value = doc[i++];
      }
    }
    if (value === ")" && kind === "symbol") {
      const open = stack.pop();
      if (open !== undefined) ends.set(open, i);
    }
    tokens.push({
      value: value || doc.slice(from, i),
      from,
      to: i,
      kind,
      closed,
      depth: stack.length,
      parent: stack[stack.length - 1],
    });
    if (value === "(" && kind === "symbol") {
      if (bounded && stack.length >= 64) return null;
      stack.push(from);
    }
  }
  return { tokens, ends };
}
function statementBounds(tokens: Token[], pos: number, length: number) {
  let from = 0;
  for (const token of tokens) {
    if (token.kind !== "symbol" || token.value !== ";" || token.depth !== 0) continue;
    if (pos <= token.from) return { from, to: token.to };
    from = token.to;
  }
  return { from, to: length };
}

export function sqlStatementAtCursor(doc: string, pos: number): string | null {
  const parsed = lex(doc, false);
  if (!parsed) return null;
  const { tokens } = parsed;
  const statementText = ({ from, to }: { from: number; to: number }) => {
    const hasStatement = tokens.some(
      (token) =>
        token.from >= from &&
        token.from < to &&
        token.kind !== "comment" &&
        !(token.kind === "symbol" && token.value === ";"),
    );
    return hasStatement ? trimSqlWhitespace(doc.slice(from, to)) : null;
  };
  const bounds = statementBounds(tokens, pos, doc.length);
  const statement = statementText(bounds);
  if (statement !== null || bounds.from === 0 || pos !== bounds.from) return statement;
  return statementText(statementBounds(tokens, pos - 1, doc.length));
}
function inLiteral(tokens: Token[], pos: number) {
  return tokens.some(
    (t) =>
      (t.kind === "string" || t.kind === "comment") &&
      t.from < pos &&
      (pos < t.to || (pos === t.to && !t.closed)),
  );
}
function scope(tokens: Token[], ends: Map<number, number>, pos: number, length: number) {
  const choices = tokens.filter(
    (t) =>
      keyword(t, "select") &&
      t.from <= pos &&
      (t.parent === undefined || (t.parent < pos && (ends.get(t.parent) ?? length + 1) > pos)),
  );
  choices.sort((a, b) => b.depth - a.depth || b.from - a.from);
  const selected = choices[0];
  const depth = selected?.depth ?? 0,
    parent = selected?.parent;
  let end = parent === undefined ? length : (ends.get(parent) ?? length);
  const next = tokens.find(
    (t) => keyword(t, "select") && t.parent === parent && t.depth === depth && t.from > pos,
  );
  if (next) end = Math.min(end, next.from);
  return { depth, parent, start: selected?.from ?? 0, end };
}
export interface SqlCompletionContext {
  kind: "dot" | "join" | "table" | "having" | "expression" | "none";
  prefixLength: number;
  tokenFrom: number;
}
const genericJoinNames = new Set([
  "id",
  "name",
  "status",
  "type",
  "value",
  "amount",
  "total",
  "created_at",
  "updated_at",
]);
function compatibleJoinTypes(a: string, b: string): boolean {
  const canonical = (value: string) => value.toUpperCase().replace(/\s+/g, "");
  const x = canonical(a),
    y = canonical(b);
  const integer =
    /^(?:U?(?:TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT)|INT(?:8|16|32|64|128)?|UINT(?:8|16|32|64))$/;
  const floating = /^(?:FLOAT|REAL|DOUBLE|FLOAT32|FLOAT64)$/;
  const text = /^(?:VARCHAR|TEXT|STRING|CHAR(?:\(\d+\))?)$/;
  if (integer.test(x) && integer.test(y)) return true;
  if (floating.test(x) && floating.test(y)) return true;
  if (text.test(x) && text.test(y)) return true;
  return (
    x === y &&
    /^(?:DECIMAL\(\d+,\d+\)|DATE|TIME(?:_NS|_MS|_US)?|TIMESTAMP(?:_NS|_MS|_US)?|TIMESTAMPTZ|TIMESTAMPWITHTIMEZONE)$/.test(
      x,
    )
  );
}
function completionAnalysis(doc: string, pos: number, tables: readonly SqlTable[]) {
  if (!Number.isInteger(pos) || pos < 0 || pos > doc.length) return null;
  const parsed = lex(doc);
  if (!parsed || inLiteral(parsed.tokens, pos)) return null;
  const statement = statementBounds(parsed.tokens, pos, doc.length);
  const tokens = parsed.tokens.filter((t) => t.from >= statement.from && t.from < statement.to);
  const { ends } = parsed;
  const context = scope(tokens, ends, pos, statement.to);
  const active = tokens.find((t) => identifier(t) && t.from < pos && t.to >= pos);
  const from = active?.from ?? pos,
    to = active?.to ?? pos;
  const prefix = active
    ? doc
        .slice(active.from + (active.kind === "quoted" ? 1 : 0), pos)
        .replace(/""/g, '"')
        .replace(/"$/, "")
    : "";
  const before = tokens.filter((t) => t.kind !== "comment" && t.to <= from);
  const info = bindingsFor(tokens, ends, context, tables, pos);
  if (!info) return null;
  const last = before[before.length - 1];
  const clauses = info.base.filter(
    (t, i) =>
      t.to <= from &&
      t.kind === "word" &&
      !(keyword(t, "from") && keyword(info.base[i - 1], "distinct")) &&
      [
        "select",
        "from",
        "join",
        "where",
        "on",
        "using",
        "group",
        "order",
        "having",
        "qualify",
        "window",
        "limit",
        "offset",
        "union",
        "except",
        "intersect",
      ].includes(key(t.value)),
  );
  const clause = clauses[clauses.length - 1];
  const tablePosition =
    last !== undefined &&
    last.depth === context.depth &&
    last.parent === context.parent &&
    (last === clause || last.value === ",") &&
    (keyword(clause, "from") || keyword(clause, "join"));
  return { context, info, before, last, active, from, to, prefix, clause, tablePosition };
}
function joinOptions(
  analysis: NonNullable<ReturnType<typeof completionAnalysis>>,
): SqlCompletionOption[] | null {
  const { info, last, prefix } = analysis;
  // Only a fresh ON predicate, not an existing equality, AND or nested expression.
  if (
    !keyword(last, "on") ||
    last.depth !== analysis.context.depth ||
    last.parent !== analysis.context.parent
  )
    return null;
  const next = info.base.find((t) => t.from >= analysis.to && t.from > last.from);
  if (
    next &&
    next.value !== ";" &&
    !(
      next.kind === "word" &&
      [
        "join",
        "left",
        "right",
        "full",
        "inner",
        "cross",
        "where",
        "group",
        "order",
        "having",
        "qualify",
        "limit",
        "offset",
        "union",
        "intersect",
        "except",
      ].includes(key(next.value))
    )
  )
    return null;
  const preceding = info.base.filter((t) => t.to <= last.from);
  let join: Token | undefined;
  for (const token of preceding) {
    if (keyword(token, "join")) join = token;
    else if (
      token.kind === "word" &&
      ["on", "where", "using", "group", "order", "having", "qualify", "limit", "union"].includes(
        key(token.value),
      )
    )
      join = undefined;
  }
  if (!join) return null;
  const rightIndex = info.bindings.findIndex(
    (b) => b.relationFrom > join!.from && b.relationFrom < last.from,
  );
  if (rightIndex < 0) return null;
  const right = info.bindings[rightIndex];
  const uniqueAlias = (binding: Binding) =>
    info.bindings.filter((b) => key(b.alias) === key(binding.alias)).length === 1;
  if (!right.table || !uniqueAlias(right)) return null;
  const uniqueColumns = (binding: Binding) => {
    const counts = new Map<string, number>();
    for (const c of binding.table?.columns.slice(0, 4096) ?? [])
      counts.set(key(c.originalName), (counts.get(key(c.originalName)) ?? 0) + 1);
    return (binding.table?.columns.slice(0, 4096) ?? []).filter(
      (c) => c.originalName.trim() && counts.get(key(c.originalName)) === 1,
    );
  };
  const rightColumns = new Map(uniqueColumns(right).map((c) => [key(c.originalName), c]));
  const strong: SqlCompletionOption[] = [],
    weak: SqlCompletionOption[] = [];
  for (const left of info.bindings.slice(0, rightIndex).reverse()) {
    if (!left.table || !uniqueAlias(left)) continue;
    for (const c of uniqueColumns(left)) {
      const r = rightColumns.get(key(c.originalName));
      if (!r || !compatibleJoinTypes(c.sqlType, r.sqlType)) continue;
      const leftName = sqlColumnName(c, left.table.columnMode),
        rightName = sqlColumnName(r, right.table.columnMode);
      const label =
        left.alias +
        "." +
        (left.table.columnMode === "ordinal" ? "c" + (c.sourceIndex + 1) : c.originalName) +
        " = " +
        right.alias +
        "." +
        (right.table.columnMode === "ordinal" ? "c" + (r.sourceIndex + 1) : r.originalName);
      if (prefix && !key(label + " " + c.originalName).includes(key(prefix))) continue;
      const generic = genericJoinNames.has(key(c.originalName).trim());
      const bucket = generic ? weak : strong;
      if (strong.length + weak.length >= MAX_COMPLETION_OPTIONS) {
        if (generic || strong.length >= MAX_COMPLETION_OPTIONS) continue;
        weak.pop();
      }
      bucket.push({
        label,
        insertText:
          sqlIdentifier(left.alias) +
          "." +
          leftName +
          " = " +
          sqlIdentifier(right.alias) +
          "." +
          rightName,
        type: "join",
        detail: generic ? "Ambiguous key" : "Suggested JOIN",
        info: "Inferred, not a verified foreign key.",
        infoDetails:
          `Matching original column: ${c.originalName}. Types: ${c.sqlType} ↔ ${r.sqlType}. ` +
          "Suggested from column metadata only; uniqueness and matching data were not checked. " +
          (generic ? "This common column name can be unrelated. " : "") +
          "Check the relationship before using it.",
        boost: generic ? -100 : 100,
        manualOnly: generic,
      });
    }
  }
  // Bounded allocation, with meaningful keys ranked before generic identifiers.
  return [...strong, ...weak].slice(0, MAX_COMPLETION_OPTIONS);
}
export function sqlCompletionContext(
  doc: string,
  pos: number,
  tables: readonly SqlTable[],
): SqlCompletionContext {
  const a = completionAnalysis(doc, pos, tables);
  if (!a) return { kind: "none", prefixLength: 0, tokenFrom: pos };
  const common = { prefixLength: [...a.prefix].length, tokenFrom: a.from };
  if (a.last?.value === ".") return { kind: "dot", ...common };
  const joins = joinOptions(a);
  if (joins?.some((o) => o.boost! > 0)) return { kind: "join", ...common };
  if (a.tablePosition) return { kind: "table", ...common };
  if (keyword(a.clause, "having")) return { kind: "having", ...common };
  return { kind: "expression", ...common };
}

function selectAliases(base: Token[], having: Token) {
  const aliases = new Map<string, string | null>();
  if (!keyword(base[0], "select")) return aliases;
  let start = 1;
  for (let i = start; i < base.length; i++) {
    const token = base[i];
    const endsProjection =
      token === having ||
      (keyword(token, "from") && !keyword(base[i - 1], "distinct")) ||
      keyword(token, "where") ||
      keyword(token, "group");
    if (!endsProjection && !(token.kind === "symbol" && token.value === ",")) continue;
    const alias = base[i - 1];
    if (i - start >= 3 && keyword(base[i - 2], "as") && identifier(alias) && alias.closed) {
      const name = key(alias.value);
      aliases.set(name, aliases.has(name) ? null : alias.value);
    }
    if (endsProjection) break;
    start = i + 1;
  }
  return aliases;
}

export function sqlCompletions(
  doc: string,
  pos: number,
  tables: readonly SqlTable[],
): SqlCompletionResult | null {
  const analysis = completionAnalysis(doc, pos, tables);
  if (!analysis) return null;
  const { context, info, before, last, from, to, prefix, tablePosition } = analysis;
  const joins = joinOptions(analysis);
  if (joins?.length) return { from, to, options: joins };
  const options: SqlCompletionOption[] = [];
  const offer = (option: SqlCompletionOption, search = option.label) => {
    if (options.length >= MAX_COMPLETION_OPTIONS) return;
    const matches =
      option.type === "function" || option.type === "keyword"
        ? key(search).startsWith(key(prefix))
        : key(search).includes(key(prefix));
    if (!prefix || matches) options.push(option);
  };
  const columns = (binding: Binding, qualified: boolean) => {
    if (binding.cte?.columns) {
      const output = new Map<string, string | null>();
      for (const name of binding.cte.columns)
        if (name !== null) output.set(key(name), output.has(key(name)) ? null : name);
      for (const name of output.values()) {
        if (options.length >= MAX_COMPLETION_OPTIONS) break;
        if (name === null) continue;
        offer(
          {
            label: qualified ? `${binding.alias}.${name}` : name,
            insertText: (qualified ? sqlIdentifier(binding.alias) + "." : "") + sqlIdentifier(name),
            type: "property",
            detail: `CTE · ${binding.cte.name}`,
          },
          name,
        );
      }
      return;
    }
    if (!binding.table) return;
    for (const c of binding.table.columns) {
      if (options.length >= MAX_COMPLETION_OPTIONS) break;
      const sqlName = sqlColumnName(c, binding.table.columnMode);
      const name =
        binding.table.columnMode === "ordinal" ? `c${c.sourceIndex + 1}` : c.originalName;
      offer(
        {
          label: qualified ? `${binding.alias}.${name}` : name,
          insertText: (qualified ? sqlIdentifier(binding.alias) + "." : "") + sqlName,
          type: "property",
          detail:
            binding.table.columnMode === "ordinal" ? `${c.sqlType} · ${c.originalName}` : c.sqlType,
          info: `${c.originalName}\n${c.sqlType}${c.nullable ? " · nullable" : ""}`,
        },
        `${name} ${c.originalName}`,
      );
    }
  };
  if (last?.value === ".") {
    const qualifier = before[before.length - 2];
    if (!identifier(qualifier) || before[before.length - 3]?.value === ".") return null;
    const matches = info.bindings.filter((b) => key(b.alias) === key(qualifier.value));
    const name = key(qualifier.value);
    const binding =
      matches.length === 1
        ? matches[0]
        : matches.length === 0 && info.bindings.length === 0 && context.depth === 0
          ? {
              alias: qualifier.value,
              table: info.ctes.has(name) ? null : (info.catalogue.get(name) ?? null),
              cte: info.ctes.get(name) ?? undefined,
              relationFrom: -1,
            }
          : null;
    if (binding) columns(binding, false);
  } else if (tablePosition) {
    for (const cte of info.ctes.values()) {
      if (!cte) continue;
      offer({
        label: cte.name,
        insertText: sqlIdentifier(cte.name),
        type: "table",
        detail: "CTE",
        boost: 10,
      });
    }
    for (const [name, table] of info.catalogue)
      if (table && !info.ctes.has(name))
        offer({
          label: table.alias,
          insertText: sqlIdentifier(table.alias),
          type: "table",
          detail: `${table.fileName} · ${table.columnMode === "ordinal" ? "c-number columns" : "original names"}`,
        });
  } else {
    const clauseName = analysis.clause ? key(analysis.clause.value) : "";
    if (analysis.clause && clauseName === "having") {
      for (const alias of selectAliases(info.base, analysis.clause).values()) {
        if (alias !== null)
          offer({
            label: alias,
            insertText: sqlIdentifier(alias),
            type: "property",
            detail: "SELECT alias",
            boost: 10,
          });
      }
    }
    const resolved = info.bindings.filter(
      (b) =>
        (b.table || b.cte) &&
        info.bindings.filter((other) => key(other.alias) === key(b.alias)).length === 1,
    );
    for (const b of resolved) columns(b, info.bindings.length > 1);
    for (const f of SQL_FUNCTIONS)
      offer({
        label: f.name,
        insertText: f.name,
        type: "function",
        detail: f.signature,
        info: f.description,
      });
    const words = !clauseName
      ? ["SELECT", "WITH"]
      : ["order", "group"].includes(clauseName) &&
          (keyword(last, "order") || keyword(last, "group"))
        ? ["BY"]
        : ["order", "group"].includes(clauseName)
          ? ["ASC", "DESC", "NULLS FIRST", "NULLS LAST", "HAVING", "LIMIT", "OFFSET"]
          : ["from", "join"].includes(clauseName)
            ? [
                "AS",
                "JOIN",
                "LEFT JOIN",
                "RIGHT JOIN",
                "INNER JOIN",
                "ON",
                "WHERE",
                "GROUP BY",
                "ORDER BY",
                "LIMIT",
              ]
            : ["where", "on", "having", "qualify"].includes(clauseName)
              ? [
                  "AND",
                  "OR",
                  "NOT",
                  "NULL",
                  "IS",
                  "IN",
                  "BETWEEN",
                  "LIKE",
                  "ILIKE",
                  "CASE",
                  "WHEN",
                  "THEN",
                  "ELSE",
                  "END",
                  "GROUP BY",
                  "ORDER BY",
                  "LIMIT",
                ]
              : [
                  "AS",
                  "DISTINCT",
                  "FROM",
                  "CASE",
                  "WHEN",
                  "THEN",
                  "ELSE",
                  "END",
                  "OVER",
                  "PARTITION BY",
                  "FILTER",
                ];
    for (const word of words) offer({ label: word, insertText: word, type: "keyword" });
  }
  return options.length ? { from, to, options } : null;
}

export function sqlFunctionHint(doc: string, pos: number): SqlFunctionHint | null {
  if (!Number.isInteger(pos) || pos < 0 || pos > doc.length) return null;
  const parsed = lex(doc);
  if (!parsed || inLiteral(parsed.tokens, pos)) return null;
  const tokens = parsed.tokens.filter((t) => t.kind !== "comment" && t.to <= pos);
  const stack: { token: Token; name?: string; argumentIndex: number }[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.value === "(" && t.kind === "symbol")
      stack.push({
        token: t,
        name:
          tokens[i - 1]?.kind === "word" && tokens[i - 2]?.value !== "."
            ? key(tokens[i - 1].value)
            : undefined,
        argumentIndex: 1,
      });
    else if (t.value === ")" && t.kind === "symbol") stack.pop();
    else if (t.value === "," && t.kind === "symbol" && stack.length)
      stack[stack.length - 1].argumentIndex++;
  }
  for (const call of stack.reverse()) {
    if (!call.name) continue;
    const f = SQL_FUNCTIONS.find((f) => key(f.name) === call.name);
    return f ? { ...f, argumentIndex: call.argumentIndex, from: call.token.from, to: pos } : null;
  }
  return null;
}
