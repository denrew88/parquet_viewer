//! Native statement extraction plus a deliberately conservative SQL subset.
//! This lexer is not a replacement parser: DuckDB parses and classifies the
//! sole extracted statement. It only rejects syntax/functions outside policy.
use super::*;
use duckdb::ffi;
use std::{
    ffi::{CStr, CString},
    ptr,
};

pub(super) struct Database {
    pub connection: Option<Connection>,
    pub raw: ffi::duckdb_connection,
    db: ffi::duckdb_database,
}
impl Database {
    pub fn open() -> Result<Self, DataError> {
        unsafe {
            let mut config = ptr::null_mut();
            if ffi::duckdb_create_config(&mut config) != ffi::DuckDBSuccess {
                return Err(error("SQL database configuration failed."));
            }
            for (key, value) in [
                ("memory_limit", "256MiB"),
                ("threads", "2"),
                ("autoload_known_extensions", "false"),
                ("autoinstall_known_extensions", "false"),
                ("allow_unsigned_extensions", "false"),
            ] {
                let key =
                    CString::new(key).map_err(|_| error("Invalid internal configuration."))?;
                let value =
                    CString::new(value).map_err(|_| error("Invalid internal configuration."))?;
                if ffi::duckdb_set_config(config, key.as_ptr(), value.as_ptr())
                    != ffi::DuckDBSuccess
                {
                    ffi::duckdb_destroy_config(&mut config);
                    return Err(error("A required SQL safety setting is unavailable."));
                }
            }
            let mut db = ptr::null_mut();
            let mut err = ptr::null_mut();
            let state = ffi::duckdb_open_ext(ptr::null(), &mut db, config, &mut err);
            ffi::duckdb_destroy_config(&mut config);
            if state != ffi::DuckDBSuccess {
                let message = if err.is_null() {
                    "SQL database could not open.".to_owned()
                } else {
                    CStr::from_ptr(err).to_string_lossy().into_owned()
                };
                if !err.is_null() {
                    ffi::duckdb_free(err.cast());
                }
                return Err(duckdb_message_error(message));
            }
            let mut raw = ptr::null_mut();
            if ffi::duckdb_connect(db, &mut raw) != ffi::DuckDBSuccess {
                ffi::duckdb_close(&mut db);
                return Err(error("SQL parser connection failed."));
            }
            match Connection::open_from_raw(db) {
                Ok(connection) => Ok(Self {
                    connection: Some(connection),
                    raw,
                    db,
                }),
                Err(e) => {
                    ffi::duckdb_disconnect(&mut raw);
                    ffi::duckdb_close(&mut db);
                    Err(duckdb_error(e))
                }
            }
        }
    }
    pub fn conn(&self) -> Result<&Connection, DataError> {
        self.connection
            .as_ref()
            .ok_or_else(|| error("SQL connection closed."))
    }
    pub fn stream(
        &self,
        sql: &str,
        schema: std::sync::Arc<arrow_schema::Schema>,
    ) -> Result<NativeStream, DataError> {
        let text = CString::new(sql).map_err(|_| invalid("SQL contains NUL."))?;
        unsafe {
            let mut extracted = ptr::null_mut();
            let count = ffi::duckdb_extract_statements(self.raw, text.as_ptr(), &mut extracted);
            if count != 1 {
                ffi::duckdb_destroy_extracted(&mut extracted);
                return Err(invalid("SQL must be one statement."));
            }
            let mut statement = ptr::null_mut();
            let state =
                ffi::duckdb_prepare_extracted_statement(self.raw, extracted, 0, &mut statement);
            ffi::duckdb_destroy_extracted(&mut extracted);
            if state != ffi::DuckDBSuccess {
                let p = ffi::duckdb_prepare_error(statement);
                let message = if p.is_null() {
                    "SQL could not be prepared.".to_owned()
                } else {
                    CStr::from_ptr(p).to_string_lossy().into_owned()
                };
                ffi::duckdb_destroy_prepare(&mut statement);
                return Err(duckdb_message_error(message));
            }
            if ffi::duckdb_prepared_statement_type(statement)
                != ffi::duckdb_statement_type_DUCKDB_STATEMENT_TYPE_SELECT
            {
                ffi::duckdb_destroy_prepare(&mut statement);
                return Err(invalid("Only SELECT results can be streamed."));
            }
            let mut result = std::mem::zeroed();
            let rc = ffi::duckdb_execute_prepared_streaming(statement, &mut result);
            let mut stream = NativeStream {
                statement,
                result,
                schema,
            };
            if rc != ffi::DuckDBSuccess {
                return Err(stream
                    .result_error()
                    .unwrap_or_else(|| error("SQL execution failed.")));
            }
            Ok(stream)
        }
    }
    pub fn referenced_tables(
        &self,
        sql: &str,
        aliases: &[String],
    ) -> Result<Vec<String>, DataError> {
        // Extraction is non-executing and MUST precede every user SQL prepare.
        let text = CString::new(sql).map_err(|_| invalid("SQL contains NUL."))?;
        unsafe {
            let mut extracted = ptr::null_mut();
            let count = ffi::duckdb_extract_statements(self.raw, text.as_ptr(), &mut extracted);
            if count != 1 {
                ffi::duckdb_destroy_extracted(&mut extracted);
                return Err(invalid(
                    "SQL must contain exactly one valid SELECT or SELECT CTE statement.",
                ));
            }
            if let Err(e) = validate_tokens(sql) {
                ffi::duckdb_destroy_extracted(&mut extracted);
                return Err(e);
            }
            // This API traverses parsed table references, including nested SELECT/CTEs.
            let mut names = ffi::duckdb_get_table_names(self.raw, text.as_ptr(), false);
            if names.is_null() {
                ffi::duckdb_destroy_extracted(&mut extracted);
                return Err(invalid("SQL table references could not be inspected."));
            }
            let mut references = Vec::new();
            for index in 0..ffi::duckdb_get_list_size(names) {
                let mut child = ffi::duckdb_get_list_child(names, index);
                let value = ffi::duckdb_get_varchar(child);
                let name = if value.is_null() {
                    String::new()
                } else {
                    CStr::from_ptr(value).to_string_lossy().into_owned()
                };
                if !value.is_null() {
                    ffi::duckdb_free(value.cast());
                }
                ffi::duckdb_destroy_value(&mut child);
                if !aliases.iter().any(|a| a.eq_ignore_ascii_case(&name)) {
                    ffi::duckdb_destroy_value(&mut names);
                    ffi::duckdb_destroy_extracted(&mut extracted);
                    return Err(invalid(format!(
                        "Only registered SQL tables may be queried: {name}"
                    )));
                }
                references.push(name);
            }
            ffi::duckdb_destroy_value(&mut names);
            ffi::duckdb_destroy_extracted(&mut extracted);
            Ok(references)
        }
    }
    pub fn validate(&self, sql: &str, aliases: &[String]) -> Result<(), DataError> {
        self.referenced_tables(sql, aliases)?;
        let text = CString::new(sql).map_err(|_| invalid("SQL contains NUL."))?;
        unsafe {
            let mut extracted = ptr::null_mut();
            if ffi::duckdb_extract_statements(self.raw, text.as_ptr(), &mut extracted) != 1 {
                ffi::duckdb_destroy_extracted(&mut extracted);
                return Err(invalid("SQL must contain exactly one SELECT statement."));
            }
            let mut statement = ptr::null_mut();
            let state =
                ffi::duckdb_prepare_extracted_statement(self.raw, extracted, 0, &mut statement);
            ffi::duckdb_destroy_extracted(&mut extracted);
            if state != ffi::DuckDBSuccess {
                let p = ffi::duckdb_prepare_error(statement);
                let message = if p.is_null() {
                    "SQL could not be bound.".to_owned()
                } else {
                    CStr::from_ptr(p).to_string_lossy().into_owned()
                };
                ffi::duckdb_destroy_prepare(&mut statement);
                return Err(duckdb_message_error(message));
            }
            let kind = ffi::duckdb_prepared_statement_type(statement);
            ffi::duckdb_destroy_prepare(&mut statement);
            if kind != ffi::duckdb_statement_type_DUCKDB_STATEMENT_TYPE_SELECT {
                return Err(invalid("Only a single SELECT or SELECT CTE is allowed."));
            }
        }
        Ok(())
    }
}
impl Drop for Database {
    fn drop(&mut self) {
        self.connection.take();
        unsafe {
            ffi::duckdb_disconnect(&mut self.raw);
            ffi::duckdb_close(&mut self.db);
        }
    }
}

pub(super) struct NativeStream {
    statement: ffi::duckdb_prepared_statement,
    result: ffi::duckdb_result,
    schema: std::sync::Arc<arrow_schema::Schema>,
}
impl NativeStream {
    fn result_error(&mut self) -> Option<DataError> {
        unsafe {
            let p = ffi::duckdb_result_error(&mut self.result);
            if p.is_null() {
                None
            } else {
                let s = CStr::from_ptr(p).to_string_lossy();
                if s.is_empty() {
                    None
                } else {
                    Some(duckdb_message_error(s.into_owned()))
                }
            }
        }
    }
    pub fn next_batch(&mut self) -> Result<Option<RecordBatch>, DataError> {
        use duckdb::arrow::{
            array::StructArray,
            ffi::{from_ffi, FFI_ArrowArray, FFI_ArrowSchema},
        };
        unsafe {
            let mut chunk = if ffi::duckdb_result_is_streaming(self.result) {
                ffi::duckdb_stream_fetch_chunk(self.result)
            } else {
                ffi::duckdb_fetch_chunk(self.result)
            };
            if chunk.is_null() {
                return match self.result_error() {
                    Some(e) => Err(e),
                    None => Ok(None),
                };
            }
            let mut array = FFI_ArrowArray::empty();
            // DuckDB expects the address of the ArrowArray pointer, not the
            // ArrowArray struct itself (duckdb_arrow_array is an opaque pointer).
            let mut array_pointer = std::ptr::addr_of_mut!(array);
            ffi::duckdb_result_arrow_array(
                self.result,
                chunk,
                (&mut array_pointer as *mut *mut FFI_ArrowArray).cast(),
            );
            ffi::duckdb_destroy_data_chunk(&mut chunk);
            if let Some(e) = self.result_error() {
                return Err(e);
            }
            if array.is_empty() {
                return Err(error(
                    "SQL returned an empty Arrow batch before stream completion.",
                ));
            }
            let schema = FFI_ArrowSchema::try_from(self.schema.as_ref())
                .map_err(|e| error(e.to_string()))?;
            let data = from_ffi(array, &schema).map_err(|e| error(e.to_string()))?;
            Ok(Some(RecordBatch::from(&StructArray::from(data))))
        }
    }
}
impl Drop for NativeStream {
    fn drop(&mut self) {
        unsafe {
            ffi::duckdb_destroy_result(&mut self.result);
            ffi::duckdb_destroy_prepare(&mut self.statement);
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Token {
    Word(String),
    Quoted(String),
    Literal,
    Symbol(char),
}
impl Token {
    fn word(&self) -> Option<&str> {
        match self {
            Self::Word(w) | Self::Quoted(w) => Some(w),
            _ => None,
        }
    }
}
fn tokens(sql: &str) -> Result<Vec<Token>, DataError> {
    let chars = sql.chars().collect::<Vec<_>>();
    let mut i = 0;
    let mut out = Vec::new();
    while i < chars.len() {
        let c = chars[i];
        if c.is_whitespace() {
            i += 1;
            continue;
        }
        if c == '-' && chars.get(i + 1) == Some(&'-') {
            i += 2;
            while i < chars.len() && chars[i] != '\n' {
                i += 1;
            }
            continue;
        }
        if c == '/' && chars.get(i + 1) == Some(&'*') {
            i += 2;
            let mut depth = 1;
            while i < chars.len() && depth > 0 {
                if chars[i] == '/' && chars.get(i + 1) == Some(&'*') {
                    depth += 1;
                    i += 2;
                    if depth > 64 {
                        return Err(invalid("SQL comment nesting exceeds its limit."));
                    }
                } else if chars[i] == '*' && chars.get(i + 1) == Some(&'/') {
                    depth -= 1;
                    i += 2;
                } else {
                    i += 1;
                }
            }
            if depth != 0 {
                return Err(invalid("Unclosed SQL comment."));
            }
            continue;
        }
        if c == '\'' || c == '"' {
            let quote = c;
            let mut value = String::new();
            i += 1;
            let mut closed = false;
            while i < chars.len() {
                if chars[i] == quote {
                    if chars.get(i + 1) == Some(&quote) {
                        value.push(quote);
                        i += 2;
                        continue;
                    }
                    closed = true;
                    i += 1;
                    break;
                }
                value.push(chars[i]);
                i += 1;
            }
            if !closed {
                return Err(invalid("Unclosed SQL string or identifier."));
            }
            out.push(if quote == '"' {
                Token::Quoted(value)
            } else {
                Token::Literal
            });
            continue;
        }
        if c == '$' {
            let mut end = i + 1;
            while end < chars.len() && (chars[end].is_ascii_alphanumeric() || chars[end] == '_') {
                end += 1;
            }
            if chars.get(end) == Some(&'$') {
                let tag = chars[i..=end].to_vec();
                i = end + 1;
                let mut found = false;
                while i + tag.len() <= chars.len() {
                    if chars[i..i + tag.len()] == tag {
                        i += tag.len();
                        found = true;
                        break;
                    }
                    i += 1;
                }
                if !found {
                    return Err(invalid("Unclosed dollar-quoted SQL string."));
                }
                out.push(Token::Literal);
                continue;
            }
            return Err(invalid(
                "SQL parameters are not supported in this workspace.",
            ));
        }
        if c.is_alphanumeric() || c == '_' {
            let start = i;
            i += 1;
            while i < chars.len() && (chars[i].is_alphanumeric() || chars[i] == '_') {
                i += 1;
            }
            out.push(Token::Word(
                chars[start..i]
                    .iter()
                    .collect::<String>()
                    .to_ascii_lowercase(),
            ));
        } else {
            out.push(Token::Symbol(c));
            i += 1;
        }
    }
    Ok(out)
}
fn validate_tokens(sql: &str) -> Result<(), DataError> {
    let t = tokens(sql)?;
    if !matches!(t.first(),Some(Token::Word(w)) if w=="select"||w=="with") {
        return Err(invalid("Only SELECT and SELECT CTE queries are supported."));
    }
    let mut cte_lists = std::collections::HashSet::new();
    for start in 0..t.len() {
        if !matches!(&t[start],Token::Word(w) if w=="with") {
            continue;
        }
        let mut i = start + 1;
        if matches!(t.get(i),Some(Token::Word(w)) if w=="recursive") {
            i += 1;
        }
        loop {
            if t.get(i).and_then(Token::word).is_none() {
                break;
            }
            let name = i;
            i += 1;
            if t.get(i) == Some(&Token::Symbol('(')) {
                let mut j = i + 1;
                let mut identifiers = true;
                while j < t.len() && t[j] != Token::Symbol(')') {
                    if !matches!(
                        &t[j],
                        Token::Word(_) | Token::Quoted(_) | Token::Symbol(',')
                    ) {
                        identifiers = false;
                    }
                    j += 1;
                }
                if identifiers && matches!(t.get(j+1),Some(Token::Word(w)) if w=="as") {
                    cte_lists.insert(name);
                }
                i = j + 1;
            }
            if !matches!(t.get(i),Some(Token::Word(w)) if w=="as") {
                break;
            }
            i += 1;
            while matches!(t.get(i),Some(Token::Word(w)) if w=="not"||w=="materialized") {
                i += 1;
            }
            if t.get(i) != Some(&Token::Symbol('(')) {
                break;
            }
            let mut depth = 1;
            i += 1;
            while i < t.len() && depth > 0 {
                if t[i] == Token::Symbol('(') {
                    depth += 1;
                } else if t[i] == Token::Symbol(')') {
                    depth -= 1;
                }
                i += 1;
            }
            if t.get(i) == Some(&Token::Symbol(',')) {
                i += 1;
            } else {
                break;
            }
        }
    }
    let forbidden = [
        "copy",
        "create",
        "insert",
        "update",
        "delete",
        "drop",
        "alter",
        "attach",
        "detach",
        "set",
        "reset",
        "pragma",
        "install",
        "load",
        "export",
        "import",
        "call",
        "execute",
        "prepare",
        "explain",
        "vacuum",
        "checkpoint",
        "secret",
    ];
    // Conservative allow-list: all other calls fail closed. No file, catalog,
    // extension, dynamic query, environment or network function is admitted.
    let functions = [
        "abs",
        "ceil",
        "ceiling",
        "floor",
        "round",
        "trunc",
        "sqrt",
        "pow",
        "power",
        "exp",
        "ln",
        "log",
        "log10",
        "sign",
        "greatest",
        "least",
        "coalesce",
        "nullif",
        "if",
        "ifnull",
        "isnan",
        "isfinite",
        "isinf",
        "lower",
        "upper",
        "length",
        "char_length",
        "octet_length",
        "trim",
        "ltrim",
        "rtrim",
        "substring",
        "substr",
        "replace",
        "concat",
        "concat_ws",
        "starts_with",
        "ends_with",
        "contains",
        "left",
        "right",
        "split_part",
        "regexp_matches",
        "regexp_full_match",
        "regexp_replace",
        "cast",
        "try_cast",
        "count",
        "sum",
        "avg",
        "min",
        "max",
        "median",
        "stddev",
        "stddev_pop",
        "stddev_samp",
        "variance",
        "var_pop",
        "var_samp",
        "bool_and",
        "bool_or",
        "count_if",
        "first",
        "last",
        "any_value",
        "string_agg",
        "list",
        "array_agg",
        "row_number",
        "rank",
        "dense_rank",
        "percent_rank",
        "cume_dist",
        "ntile",
        "lag",
        "lead",
        "first_value",
        "last_value",
        "nth_value",
        "date_part",
        "date_trunc",
        "date_diff",
        "datediff",
        "date_add",
        "strftime",
        "strptime",
        "try_strptime",
        "year",
        "month",
        "day",
        "hour",
        "minute",
        "second",
        "epoch",
        "epoch_ms",
        "epoch_us",
        "epoch_ns",
        "make_date",
        "make_timestamp",
        "make_timestamp_ns",
        "to_timestamp",
        "typeof",
        "struct_pack",
        "list_value",
        "array_length",
        "list_extract",
        "list_contains",
        "list_count",
        "unnest",
        "range",
        "generate_series",
    ];
    let syntax = [
        "as",
        "in",
        "over",
        "filter",
        "values",
        "grouping",
        "rollup",
        "cube",
        "grouping_sets",
        "exists",
        "select",
        "distinct",
        "on",
        "using",
        "not",
        "case",
        "when",
        "then",
        "else",
        "end",
        "and",
        "or",
        "from",
        "join",
        "lateral",
        "any",
        "all",
        "some",
    ];
    for (i, token) in t.iter().enumerate() {
        if let Token::Word(w) = token {
            if forbidden.contains(&w.as_str()) {
                return Err(invalid(format!("SQL command is not allowed: {w}")));
            }
        }
        if matches!(token, Token::Symbol('.')) {
            // Explicit schema/catalog qualification is outside the registered-table namespace.
            if i >= 1
                && i + 1 < t.len()
                && t[i - 1].word().is_some_and(|w| {
                    ["main", "temp", "information_schema", "pg_catalog"]
                        .contains(&w.to_ascii_lowercase().as_str())
                })
            {
                return Err(invalid("SQL catalog and schema access is not supported."));
            }
        }
        if matches!(t.get(i + 1), Some(Token::Symbol('('))) {
            if let Some(name) = token.word() {
                let lower = name.to_ascii_lowercase();
                if [
                    "query",
                    "query_table",
                    "current_setting",
                    "getvariable",
                    "getenv",
                    "glob",
                ]
                .contains(&lower.as_str())
                    || ["read_", "write_", "duckdb_", "pragma_", "parquet_"]
                        .iter()
                        .any(|prefix| lower.starts_with(prefix))
                {
                    return Err(invalid(format!(
                        "SQL function is outside the registered-source policy: {name}"
                    )));
                }
                if functions.contains(&lower.as_str()) || syntax.contains(&lower.as_str()) {
                    continue;
                }
                // Declared CTE column lists and derived-relation alias column lists are
                // syntax, not callable functions; the closing list must contain identifiers only.
                let mut j = i + 2;
                let mut identifiers = true;
                while j < t.len() && t[j] != Token::Symbol(')') {
                    if !matches!(
                        &t[j],
                        Token::Word(_) | Token::Quoted(_) | Token::Symbol(',')
                    ) {
                        identifiers = false;
                    }
                    j += 1;
                }
                let cte_list = identifiers && cte_lists.contains(&i);
                let derived_list = identifiers
                    && i > 0
                    && (matches!(t.get(i-1),Some(Token::Word(w)) if w=="as")
                        || matches!(t.get(i - 1), Some(Token::Symbol(')'))));
                if !cte_list && !derived_list {
                    return Err(invalid(format!(
                        "SQL function is not supported by the read-only workspace: {name}"
                    )));
                }
            }
        }
    }
    Ok(())
}

pub(super) fn query_body(sql: &str) -> Result<String, DataError> {
    // Replace only non-literal terminators after the native parser verified one
    // statement. Preserve semicolons inside strings/identifiers/comments.
    let mut out = String::with_capacity(sql.len());
    let chars = sql.chars().collect::<Vec<_>>();
    let mut i = 0;
    let mut quote = None;
    let mut block = 0u32;
    let mut line = false;
    let mut dollar: Option<Vec<char>> = None;
    while i < chars.len() {
        let c = chars[i];
        if let Some(tag) = &dollar {
            if chars.get(i..i + tag.len()) == Some(tag.as_slice()) {
                out.extend(tag);
                i += tag.len();
                dollar = None;
            } else {
                out.push(c);
                i += 1;
            }
            continue;
        }
        if line {
            out.push(c);
            i += 1;
            if c == '\n' {
                line = false;
            }
            continue;
        }
        if block > 0 {
            if c == '/' && chars.get(i + 1) == Some(&'*') {
                out.push('/');
                out.push('*');
                block += 1;
                i += 2;
            } else if c == '*' && chars.get(i + 1) == Some(&'/') {
                out.push('*');
                out.push('/');
                block -= 1;
                i += 2;
            } else {
                out.push(c);
                i += 1;
            }
            continue;
        }
        if let Some(q) = quote {
            out.push(c);
            i += 1;
            if c == q {
                if chars.get(i) == Some(&q) {
                    out.push(q);
                    i += 1;
                } else {
                    quote = None;
                }
            }
            continue;
        }
        if c == '-' && chars.get(i + 1) == Some(&'-') {
            line = true;
            out.push(c);
            i += 1;
            continue;
        }
        if c == '/' && chars.get(i + 1) == Some(&'*') {
            block = 1;
            out.push('/');
            out.push('*');
            i += 2;
            continue;
        }
        if c == '\'' || c == '"' {
            quote = Some(c);
            out.push(c);
            i += 1;
            continue;
        }
        if c == '$' {
            let mut end = i + 1;
            while end < chars.len() && (chars[end].is_ascii_alphanumeric() || chars[end] == '_') {
                end += 1;
            }
            if chars.get(end) == Some(&'$') {
                let tag = chars[i..=end].to_vec();
                out.extend(&tag);
                dollar = Some(tag);
                i = end + 1;
                continue;
            }
        }
        out.push(if c == ';' { ' ' } else { c });
        i += 1;
    }
    if quote.is_some() || block > 0 || dollar.is_some() {
        return Err(invalid("Incomplete SQL text."));
    }
    out.push('\n');
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn lexer_ignores_quoted_and_commented_commands() {
        for sql in [
            "SELECT ';COPY x;' AS \"create\"",
            "/* SELECT; */ WITH x(n) AS (SELECT 1) SELECT n FROM x",
            "SELECT row_number() OVER (ORDER BY n) FROM (VALUES (1)) AS t(n)",
            "SELECT $$read_csv('x');$$",
        ] {
            assert!(validate_tokens(sql).is_ok(), "{sql}");
        }
    }
    #[test]
    fn lexer_rejects_dynamic_files_and_configuration() {
        for sql in [
            "SELECT * FROM read_text('existing')",
            "SELECT * FROM \"read_parquet\"('existing')",
            "WITH x AS (SELECT * FROM query('COPY x')) SELECT * FROM x",
            "SELECT current_setting('threads')",
            "SET threads=1; SELECT 1",
            "SELECT * FROM information_schema.tables",
        ] {
            assert!(validate_tokens(sql).is_err(), "{sql}");
        }
    }
}
