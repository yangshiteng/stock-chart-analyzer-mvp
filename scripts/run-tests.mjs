const testFiles = [
  "../test/analysis-intervals.test.js",
  "../test/chart-validator.test.js",
  "../test/discord-signal.test.js",
  "../test/llm.test.js",
  "../test/market-hours.test.js",
  "../test/premarket-dip.test.js",
  "../test/sell-strategy.test.js",
  "../test/side-panel.test.js",
  "../test/storage.test.js",
  "../test/symbol.test.js",
  "../test/trade-stats.test.js"
];

for (const file of testFiles) {
  await import(file);
}
