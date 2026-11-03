// Restore the existing product regression suite in the disposable variant.
// Port only the two Polars API-specific tests to the same written-Parquet contracts.
const fs=require('node:fs');const path=require('node:path');
const exp=path.resolve(__dirname,'..'),root=path.resolve(exp,'../../..');
for(const phase of ['phase-3','phase-9','phase-10','phase-11']) {
  fs.cpSync(path.join(root,'fixtures',phase),path.join(exp,'fixtures',phase),{recursive:true});
}
const existing=path.join(exp,'size-variant/src/data/csv_polars.rs');
if(fs.readFileSync(existing,'utf8').includes('// Native provider regression module restored for validation')) {
  console.log('Existing regression module preserved; fixture paths refreshed.');
  process.exit(0);
}
const original=fs.readFileSync(path.join(root,'src-tauri/src/data/csv_polars.rs'),'utf8').replaceAll('\r\n','\n');
const at=original.indexOf('#[cfg(test)]\nmod tests');if(at<0)throw Error('original test module missing');
let tests=original.slice(at).replace('    use super::*;','    use super::*;\n    use std::sync::Arc;');
const first=tests.indexOf('    #[test]\n    fn row_identity_expression_is_explicitly_uint64()');
const next=tests.indexOf('    #[test]\n    fn cancellation_before_collection_starts_no_worker()',first);
if(first<0||next<first)throw Error('row-id test markers missing');
tests=tests.slice(0,first)+`    #[test]
    fn native_row_identity_is_explicitly_uint64() {
        let directory=tempfile::tempdir().unwrap();
        let source=directory.path().join("input.csv");
        let output=directory.path().join("prepared.parquet.partial");
        std::fs::write(&source,"source_0\\n1\\n2\\n").unwrap();
        let profile=profile(&[CsvTargetType::Text]);
        let bytes=serde_json::to_vec(&serde_json::json!({"profile":profile,"resolvedTargets":["text"],"headerUsed":true})).unwrap();
        super::super::csv_native_size::convert_profile(&source,&output,&bytes,2).unwrap();
        let reader=parquet::arrow::arrow_reader::ParquetRecordBatchReaderBuilder::try_new(File::open(output).unwrap()).unwrap();
        assert_eq!(reader.schema().field(0).name(),"__dv_row_id");
        assert_eq!(reader.schema().field(0).data_type(),&arrow_schema::DataType::UInt64);
        assert_eq!(reader.metadata().file_metadata().num_rows(),2);
    }

`+tests.slice(next);
const sinkStart=tests.indexOf('        let sink = build_product_sink(PolarsPreparedSinkSpec {');
const sinkEnd=tests.indexOf('        sink.collect().unwrap();',sinkStart)+'        sink.collect().unwrap();'.length;
if(sinkStart<0||sinkEnd<sinkStart)throw Error('sink test markers missing');
tests=tests.slice(0,sinkStart)+`        let bytes=serde_json::to_vec(&serde_json::json!({
            "profile":profile,"resolvedTargets":resolved,"headerUsed":true
        })).unwrap();
        super::super::csv_native_size::convert_profile(&source,&output,&bytes,2).unwrap();`+tests.slice(sinkEnd);
if(tests.includes('build_product_sink')||tests.includes('product_expressions('))throw Error('unported Polars API test');
const file=path.join(exp,'size-variant/src/data/csv_polars.rs');
const marker='// Native provider regression module restored for validation';
let worker=fs.readFileSync(file,'utf8').split(marker)[0].trimEnd()+'\n\n';
fs.writeFileSync(file,worker+marker+'\n'+tests);
console.log('Restored original worker/protocol/snapshot tests; preserved SQL sink assertions and written UInt64 schema assertion.');
