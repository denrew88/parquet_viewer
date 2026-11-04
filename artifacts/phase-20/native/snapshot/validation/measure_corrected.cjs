const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../../../..');
const helper = fs.readFileSync(path.join(root, 'artifacts/optimizations/rust-thin-lto/measure_products.cjs'), 'utf8')
  .replace("'40-product-size.json'", "'60-size-corrected.json'");
new Function('require', '__dirname', 'process', 'console', helper)(require, __dirname,
  {argv: ['node', 'measure_corrected.cjs', path.join(root, 'artifacts/optimizations/rust-thin-lto/optimized-product.exe'), path.join(__dirname, '../native-validation.exe')]}, console);
