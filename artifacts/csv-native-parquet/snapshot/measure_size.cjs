const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../../..');
const helper = fs.readFileSync(path.join(root,'artifacts/optimizations/rust-thin-lto/measure_products.cjs'),'utf8')
  .replace("'40-product-size.json'", "'62-product-size.json'");
// Run the already validated PE/import parser, scoped to this artifact output directory.
const runner = new Function('require','__dirname','process','console',helper);
runner(require,__dirname,{argv:['node','measure_size.cjs',
  path.join(root,'artifacts/optimizations/rust-thin-lto/optimized-product.exe'),
  path.join(__dirname,'native-product-size.exe')]}, {log: value => {
    const r=JSON.parse(value);
    console.log(JSON.stringify({baselineBytes:r.baseline.bytes,candidateBytes:r.optimized.bytes,
      baselineMiB:r.baseline.bytes/1048576,candidateMiB:r.optimized.bytes/1048576,
      reductionMiB:r.reductionBytes/1048576,reductionPercent:r.reductionPercent,
      sameMachine:r.sameMachine,sameImports:r.sameImports},null,2));
  }});
