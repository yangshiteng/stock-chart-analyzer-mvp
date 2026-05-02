const testFiles = [
  "../test/chart-validator.test.js",
  "../test/llm.test.js",
  "../test/market-hours.test.js",
  "../test/side-panel.test.js",
  "../test/storage.test.js",
  "../test/symbol.test.js",
  "../test/trade-stats.test.js"
];

for (const file of testFiles) {
  await import(file);
}
