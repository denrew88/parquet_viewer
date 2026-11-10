import { foldSqlIdentifier as key } from "./backend";
import type { SqlTable } from "./model";

const MAX_RELATIONS = 64;
const MAX_PROJECTED_COLUMNS = 4096;

export interface Token {
  value: string;
  from: number;
  to: number;
  depth: number;
  parent?: number;
  kind: "word" | "quoted" | "string" | "comment" | "symbol";
  closed: boolean;
}

export const keyword = (token: Token | undefined, word: string) =>
  token?.kind === "word" && key(token.value) === word;
export const identifier = (
  token: Token | undefined,
): token is Token & { kind: "word" | "quoted" } =>
  token?.kind === "word" || token?.kind === "quoted";

const symbol = (token: Token | undefined, value: string) =>
  token?.kind === "symbol" && token.value === value;
const nameToken = (token: Token | undefined): token is Token =>
  identifier(token) &&
  token.closed &&
  (token.kind === "quoted"
    ? token.value.length > 0
    : /^[\p{L}_][\p{L}\p{N}\p{M}_$]*$/u.test(token.value));

const boundaries = new Set([
  "where",
  "group",
  "order",
  "having",
  "limit",
  "offset",
  "qualify",
  "window",
  "union",
  "except",
  "intersect",
  "join",
  "left",
  "right",
  "inner",
  "outer",
  "full",
  "cross",
  "on",
  "using",
]);
const joinModifiers = new Set(["on", "left", "right", "inner", "outer", "full", "cross", "using"]);
const projectionEnds = new Set([
  "from",
  "where",
  "group",
  "having",
  "qualify",
  "window",
  "order",
  "limit",
  "offset",
  "union",
  "intersect",
  "except",
]);
const unnamedValues = new Set(["null", "true", "false", "default"]);

type OutputColumns = readonly (string | null)[];
export interface Cte {
  name: string;
  columns?: OutputColumns;
}
type Ctes = Map<string, Cte | null>;
type Catalogue = Map<string, SqlTable | null>;
type TokenGroups = Map<number | undefined, Token[]>;
type QueryScope = { depth: number; parent?: number; start: number; end: number };

export interface Binding {
  alias: string;
  table: SqlTable | null;
  cte?: Cte;
  relationFrom: number;
}

function relations(
  base: Token[],
  ends: Map<number, number>,
  catalogue: Catalogue,
  ctes: Ctes,
  groups?: TokenGroups,
) {
  const bindings: Binding[] = [];
  let inFrom = false;
  let expectTable = false;
  for (let i = 0; i < base.length; i++) {
    const token = base[i];
    if ((keyword(token, "from") && !keyword(base[i - 1], "distinct")) || keyword(token, "join")) {
      inFrom = true;
      expectTable = true;
      continue;
    }
    if (
      token.kind === "word" &&
      boundaries.has(key(token.value)) &&
      !joinModifiers.has(key(token.value))
    ) {
      inFrom = false;
    }
    if (inFrom && symbol(token, ",")) {
      expectTable = true;
      continue;
    }
    if (!expectTable) continue;
    expectTable = false;

    let name = "";
    let table: SqlTable | null = null;
    let cte: Cte | undefined;
    if (identifier(token)) {
      name = token.value;
      const relation = key(name);
      if (ctes.has(relation)) cte = ctes.get(relation) ?? undefined;
      else table = catalogue.get(relation) ?? null;
    } else if (!symbol(token, "(")) continue;

    if (symbol(base[i + 1], ".")) {
      table = null;
      cte = undefined;
      while (symbol(base[i + 1], ".") && identifier(base[i + 2])) i += 2;
    }
    if (symbol(token, "(") || symbol(base[i + 1], "(")) {
      table = null;
      cte = undefined;
      const open = symbol(token, "(") ? token : base[++i];
      const end = ends.get(open.from) ?? Infinity;
      while (i + 1 < base.length && base[i + 1].to <= end) i++;
    }
    const relationEnd = i;
    if (keyword(base[i + 1], "as")) {
      i++;
      if (identifier(base[i + 1])) name = base[++i].value;
    } else if (
      identifier(base[i + 1]) &&
      (base[i + 1].kind === "quoted" || !boundaries.has(key(base[i + 1].value)))
    )
      name = base[++i].value;

    if (cte && i > relationEnd && symbol(base[i + 1], "(")) {
      const names = columnList(groups?.get(base[i + 1].from));
      cte = { name: cte.name, columns: overrideColumns(names, cte.columns) };
    }

    if (name) {
      bindings.push({ alias: name, table, cte, relationFrom: token.from });
      if (bindings.length > MAX_RELATIONS) return null;
    }
  }
  return bindings;
}

function columnList(tokens: Token[] | undefined): string[] | undefined {
  if (!tokens?.length || tokens.length % 2 === 0) return undefined;
  const names: string[] = [];
  for (const [index, token] of tokens.entries()) {
    if (index % 2 === 0 && nameToken(token)) names.push(token.value);
    else if (index % 2 === 0 || !symbol(token, ",")) return undefined;
  }
  return names;
}

function starColumns(binding: Binding | undefined): OutputColumns | undefined {
  if (!binding) return undefined;
  if (binding.cte) return binding.cte.columns;
  const table = binding.table;
  if (!table || table.columns.length > MAX_PROJECTED_COLUMNS) return undefined;
  return table.columns.map((column) =>
    table.columnMode === "ordinal" ? `c${column.sourceIndex + 1}` : column.originalName,
  );
}

function overrideColumns(names?: string[], inferred?: OutputColumns): OutputColumns | undefined {
  return names && inferred ? [...names, ...inferred.slice(names.length)] : (names ?? inferred);
}

function selectColumns(
  body: Token[],
  groups: TokenGroups,
  ends: Map<number, number>,
  catalogue: Catalogue,
  inherited: Ctes,
): OutputColumns | undefined {
  const nested = keyword(body[0], "with");
  const visible = nested ? new Map(inherited) : inherited;
  const selectAt = nested ? readWith(body, 0, groups, ends, catalogue, visible, Infinity) : 0;
  if (!keyword(body[selectAt], "select")) return undefined;
  const query = body.slice(selectAt);
  let start = keyword(query[1], "distinct") || keyword(query[1], "all") ? 2 : 1;
  if (
    keyword(query[start], "on") &&
    symbol(query[start + 1], "(") &&
    symbol(query[start + 2], ")")
  ) {
    start += 3;
  }
  const end = query.findIndex(
    (token, index) =>
      index >= start &&
      ((token.kind === "word" &&
        projectionEnds.has(key(token.value)) &&
        !(keyword(token, "from") && keyword(query[index - 1], "distinct"))) ||
        symbol(token, ";")),
  );
  const projection = query.slice(start, end < 0 ? undefined : end);
  if (!projection.length) return undefined;
  let bindings: Binding[] | null | undefined;
  const allColumns: (string | null)[] = [];
  let partStart = 0;
  for (let index = 0; index <= projection.length; index++) {
    if (index < projection.length && !symbol(projection[index], ",")) continue;
    const part = projection.slice(partStart, index);
    partStart = index + 1;
    if (!part.length) return undefined;
    const last = part[part.length - 1];
    if (
      symbol(last, "*") ||
      symbol(part[0], "*") ||
      (symbol(part[1], ".") && symbol(part[2], "*"))
    ) {
      const bare = part.length === 1;
      const qualified =
        part.length === 3 && nameToken(part[0]) && symbol(part[1], ".") && symbol(last, "*");
      if (!bare && !qualified) return undefined;
      if (bindings === undefined) {
        // The first SELECT determines the output names of a positional set operation.
        const setOp = query.findIndex((token) =>
          ["union", "intersect", "except"].some((word) => keyword(token, word)),
        );
        bindings = relations(
          query.slice(0, setOp < 0 ? undefined : setOp),
          ends,
          catalogue,
          visible,
          groups,
        );
      }
      const matches = bare
        ? bindings
        : bindings?.filter((binding) => key(binding.alias) === key(part[0].value));
      const expanded = matches?.length === 1 ? starColumns(matches[0]) : undefined;
      if (!expanded || allColumns.length + expanded.length > MAX_PROJECTED_COLUMNS)
        return undefined;
      allColumns.push(...expanded);
    } else if (keyword(part[0], "columns") || keyword(part[0], "unnest")) {
      return undefined;
    } else {
      const aliased = part.length >= 3 && keyword(part[part.length - 2], "as");
      const direct =
        part.length === 1 || (part.length === 3 && nameToken(part[0]) && symbol(part[1], "."));
      allColumns.push(
        nameToken(last) &&
          (aliased || (direct && (last.kind === "quoted" || !unnamedValues.has(key(last.value)))))
          ? last.value
          : null,
      );
    }
    if (allColumns.length > MAX_PROJECTED_COLUMNS) return undefined;
  }
  return allColumns;
}

// Each group contains only its direct tokens. A complete child group is an
// adjacent opening/closing pair here, so nested expressions cannot look like
// a new CTE or SELECT-list item.
function readWith(
  base: Token[],
  at: number,
  groups: TokenGroups,
  ends: Map<number, number>,
  catalogue: Catalogue,
  visible: Ctes,
  pos: number,
) {
  const recursive = keyword(base[at + 1], "recursive");
  const declared = new Set<string>();
  let index = at + (recursive ? 2 : 1);
  while (declared.size < MAX_RELATIONS && nameToken(base[index])) {
    const name = base[index++].value;
    const folded = key(name);
    let explicit: string[] | undefined;
    if (symbol(base[index], "(") && symbol(base[index + 1], ")")) {
      explicit = columnList(groups.get(base[index].from));
      index += 2;
    }
    if (!keyword(base[index], "as")) break;
    index++;
    if (keyword(base[index], "not")) index++;
    if (keyword(base[index], "materialized")) index++;
    const open = base[index];
    if (!symbol(open, "(") || open.from >= pos) break;
    const close = ends.get(open.from) ?? Infinity;
    const duplicate = declared.has(folded);
    const current = duplicate ? null : { name, columns: explicit };
    if (pos < close) {
      if (recursive) visible.set(folded, current);
      return index;
    }
    declared.add(folded);
    if (recursive) visible.set(folded, current);
    const inferred = duplicate
      ? undefined
      : selectColumns(groups.get(open.from) ?? [], groups, ends, catalogue, visible);
    const columns = overrideColumns(explicit, inferred);
    visible.set(folded, duplicate ? null : { name, columns });
    index += 2;
    if (!symbol(base[index], ",")) return index;
    index++;
  }
  return index;
}

export function bindingsFor(
  tokens: Token[],
  ends: Map<number, number>,
  context: QueryScope,
  tables: readonly SqlTable[],
  pos: number,
) {
  const catalogue: Catalogue = new Map();
  for (const table of tables.slice(0, 32)) {
    const name = key(table.alias);
    catalogue.set(name, catalogue.has(name) ? null : table);
  }
  const ctes: Ctes = new Map();
  const withs = tokens.filter(
    (token) =>
      keyword(token, "with") &&
      token.from <= context.start &&
      (token.parent === undefined ||
        (token.parent < pos && (ends.get(token.parent) ?? Infinity) > pos)),
  );
  const groups: TokenGroups | undefined = withs.length ? new Map() : undefined;
  if (groups) {
    for (const token of tokens) {
      if (token.kind === "comment") continue;
      const siblings = groups.get(token.parent);
      if (siblings) siblings.push(token);
      else groups.set(token.parent, [token]);
    }
    for (const withToken of withs) {
      const group = groups.get(withToken.parent)!;
      if (group[0] === withToken) readWith(group, 0, groups, ends, catalogue, ctes, pos);
    }
  }
  const base = tokens.filter(
    (token) =>
      token.kind !== "comment" &&
      token.depth === context.depth &&
      token.parent === context.parent &&
      token.from >= context.start &&
      token.from < context.end,
  );
  const bindings = relations(base, ends, catalogue, ctes, groups);
  return bindings ? { bindings, catalogue, ctes, base } : null;
}
