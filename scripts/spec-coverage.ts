#!/usr/bin/env bun
/**
 * `bun run spec:coverage` — report which docs/openapi.json paths the registered
 * MCP tools call and which they do not, grouped by API tag. Offline: it parses
 * src/ and reads the spec, never the network.
 *
 * Informational by default (exit 0). `--min <percent>` or SPEC_COVERAGE_MIN sets
 * a floor: the script exits 1 when coverage is below it, 2 on a bad threshold.
 * The logic lives in tests/support/spec-coverage.ts, built on Gate 13's scanner.
 */
import { computeCoverage, formatReport, parseThreshold } from "../tests/support/spec-coverage";

let threshold: number;
try {
  threshold = parseThreshold(process.argv.slice(2), process.env);
} catch (error) {
  console.error((error as Error).message);
  process.exit(2);
}
const report = computeCoverage();
console.log(formatReport(report, threshold));
if (report.percent < threshold) {
  console.error(`spec:coverage: ${report.percent.toFixed(1)}% is below the ${threshold}% threshold`);
  process.exit(1);
}
