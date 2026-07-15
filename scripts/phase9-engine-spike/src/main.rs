use std::{
    fs,
    path::{Path, PathBuf},
    time::Instant,
};

use duckdb::{params, Connection};
use sha2::{Digest, Sha256};

const QUERIES: [(&str, &str, &str); 4] = [
    (
        "category-beta",
        "SELECT row_id FROM source WHERE category = 'beta' ORDER BY row_id",
        "2abefa67957a7d1f77b97f879b6cb05335e9a11ee1a1620b2534723a0b8458f1",
    ),
    (
        "label-contains-needle",
        "SELECT row_id FROM source WHERE contains(lower(label), 'needle') ORDER BY row_id",
        "2a025928f4b9e49302e3c9808b1c72774be80da156d3ec607f189e25ebf84249",
    ),
    (
        "combined-filter-stable-sort",
        "SELECT row_id FROM source WHERE active = true AND category IN ('beta', 'gamma') ORDER BY group_id ASC NULLS LAST, amount DESC NULLS LAST, row_id ASC",
        "c30bb856ad6286042071f484488ad798fed514427e709bf69d07630dbeabdfa5",
    ),
    (
        "optional-ascending-nulls-last",
        "SELECT row_id FROM source ORDER BY optional_value ASC NULLS LAST, row_id ASC",
        "1b3ac23597ae9a8286cf89cf4401fc15dfef397d466e942a383b03cb58666678",
    ),
];

fn sql_string(value: &Path) -> String {
    value.to_string_lossy().replace('\'', "''")
}

fn directory_bytes(path: &Path) -> u64 {
    fs::read_dir(path)
        .into_iter()
        .flatten()
        .flatten()
        .map(|entry| {
            let path = entry.path();
            if path.is_dir() {
                directory_bytes(&path)
            } else {
                entry.metadata().map(|metadata| metadata.len()).unwrap_or(0)
            }
        })
        .sum()
}

fn checksum(values: &[i64]) -> String {
    let encoded = serde_json::to_vec(values).expect("row ids serialize");
    format!("{:x}", Sha256::digest(encoded))
}

fn run_fixture(path: &Path, temp: &Path) -> duckdb::Result<serde_json::Value> {
    let connection = Connection::open_in_memory()?;
    connection.execute("SET temp_directory = ?", params![temp.to_string_lossy()])?;
    connection.execute_batch(
        "SET memory_limit = '256MiB'; SET max_temp_directory_size = '1GiB'; SET threads = 2; SET preserve_insertion_order = true; SET default_null_order = 'NULLS_LAST';",
    )?;
    let source = if path.extension().and_then(|value| value.to_str()) == Some("parquet") {
        format!("read_parquet('{}')", sql_string(path))
    } else {
        format!(
            "read_csv('{}', header=true, nullstr='NULL', auto_detect=true)",
            sql_string(path)
        )
    };
    connection.execute_batch(&format!("CREATE VIEW source AS SELECT * FROM {source}"))?;

    let started = Instant::now();
    let mut results = Vec::new();
    for (id, query, expected) in QUERIES {
        let query_started = Instant::now();
        let mut statement = connection.prepare(query)?;
        let values = statement
            .query_map([], |row| row.get::<_, i64>(0))?
            .collect::<duckdb::Result<Vec<_>>>()?;
        let actual = checksum(&values);
        if actual != expected {
            panic!("{id} checksum mismatch: expected {expected}, got {actual}");
        }
        results.push(serde_json::json!({
            "id": id,
            "rows": values.len(),
            "checksum": actual,
            "elapsedMs": query_started.elapsed().as_secs_f64() * 1000.0
        }));
    }
    Ok(serde_json::json!({
        "path": path,
        "elapsedMs": started.elapsed().as_secs_f64() * 1000.0,
        "queries": results,
        "tempBytes": directory_bytes(temp)
    }))
}

fn main() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let temp = root.join("artifacts/phase-9/engine-temp-spike");
    let _ = fs::remove_dir_all(&temp);
    fs::create_dir_all(&temp).expect("create bounded temp directory");
    let started = Instant::now();
    let csv = run_fixture(&root.join("fixtures/phase-9/query-small.csv"), &temp)
        .expect("CSV query spike");
    let parquet = run_fixture(&root.join("fixtures/phase-9/query-small.parquet"), &temp)
        .expect("Parquet query spike");
    let output = serde_json::json!({
        "engine": "duckdb",
        "duckdbRs": "1.10504",
        "memoryLimit": "256MiB",
        "tempLimit": "1GiB",
        "totalElapsedMs": started.elapsed().as_secs_f64() * 1000.0,
        "csv": csv,
        "parquet": parquet
    });
    println!(
        "{}",
        serde_json::to_string_pretty(&output).expect("result serialize")
    );
    fs::remove_dir_all(&temp).expect("remove spike temp directory");
}
