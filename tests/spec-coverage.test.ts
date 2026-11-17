/**
 * `bun run spec:coverage` (scripts/spec-coverage.ts, logic in tests/support/spec-coverage.ts).
 * The mapping is tested on tests/fixtures/spec-coverage/, a miniature src/; the
 * report against the real tree is checked for shape, not for exact numbers, so
 * adding an endpoint never breaks this suite.
 */
import { describe, expect, it } from "bun:test";
import { spawnSync } from "child_process";
import { join } from "path";
import { listSourceFiles, ROOT } from "./support/api-call-scanner";
import {
  buildCoverage,
  computeCoverage,
  formatReport,
  loadSpecPaths,
  mapToolsToSites,
  matchSpecPath,
  parseThreshold,
} from "./support/spec-coverage";

const FIXTURE_DIR = join(ROOT, "tests/fixtures/spec-coverage");
const specPaths = loadSpecPaths();
const fixture = mapToolsToSites(listSourceFiles(FIXTURE_DIR), join(FIXTURE_DIR, "index.ts"));
const pathsOf = (tool: string) => [...new Set((fixture.tools.get(tool) ?? []).map((s) => s.path))].sort();

describe("spec:coverage — tool → path mapping", () => {
  it("registers every `{ name, inputSchema }` tool and nothing else", () => {
    expect([...fixture.tools.keys()]).toEqual(["bookClass", "listClasses", "listClassesAlias", "localOnly", "readSite"]);
  });

  it("follows aliased imports, helpers, function-valued consts and callbacks transitively", () => {
    expect(pathsOf("listClasses")).toEqual(["/class/classes", "/site/sites"]);
  });

  it("gives a fall-through case the paths of the clause it falls into", () => {
    expect(pathsOf("listClassesAlias")).toEqual(pathsOf("listClasses"));
  });

  it("maps writes (.post) and call sites inside the case clause itself", () => {
    expect(pathsOf("bookClass")).toEqual(["/class/addclienttoclass"]);
    expect(pathsOf("readSite")).toEqual(["/site/sites"]);
  });

  it("maps a local-only tool to no path", () => {
    expect(pathsOf("localOnly")).toEqual([]);
  });
});

describe("spec:coverage — report", () => {
  const report = buildCoverage(specPaths, fixture);

  it("counts a spec path covered only when a tool reaches it", () => {
    expect(report.coveredPaths).toBe(3); // /class/classes, /site/sites, /class/addclienttoclass
    expect(report.totalPaths).toBe(specPaths.size);
    expect(report.percent).toBeCloseTo((3 / specPaths.size) * 100, 6);
    expect(report.localTools).toEqual(["localOnly"]);
  });

  it("groups uncovered paths by tag, and the tag totals add up to the spec", () => {
    const klass = report.byTag.find((r) => r.tag === "Class")!;
    expect(klass.covered).toBe(2);
    expect(klass.uncovered.map((p) => p.path)).not.toContain("/class/classes");
    expect(klass.uncovered.map((p) => p.path)).toContain("/class/classvisits");
    expect(report.byTag.reduce((n, r) => n + r.total, 0)).toBe(report.totalPaths);
    expect(report.byTag.reduce((n, r) => n + r.covered, 0)).toBe(report.coveredPaths);
  });

  it("lists paths called outside every tool, and calls the spec does not define", () => {
    expect(report.calledButUnreached).toEqual(["/class/classvisits", "/staff/staff"]);
    expect(report.notInSpec.map((s) => `${s.kind} ${s.path}`).sort()).toEqual(["get /class/nosuchpath", "post /class/classes"]);
  });

  it("prints the tag groups and a covered-vs-total summary", () => {
    const text = formatReport(report, 25);
    expect(text).toContain("Uncovered paths by tag:");
    expect(text).toMatch(/^ {2}Class \(2\/\d+ covered\)$/m);
    expect(text).toContain(`Summary: 3/${specPaths.size} spec paths covered`);
    expect(text).toContain("threshold 25%");
  });
});

describe("spec:coverage — spec matching", () => {
  it("matches exact paths case-insensitively, `{param}` templates, and nothing else", () => {
    expect(matchSpecPath(specPaths, "/Class/Classes/")).toBe("/class/classes");
    expect(matchSpecPath(specPaths, "/pickaspot/v1/class/123")).toBe("/pickaspot/v1/class/{classid}");
    expect(matchSpecPath(specPaths, "/pickaspot/v1/class/123/extra")).toBeNull();
    expect(matchSpecPath(specPaths, "/class/nosuchpath")).toBeNull();
  });

  it("loads every spec path with its first tag and its methods", () => {
    expect(specPaths.size).toBeGreaterThan(100);
    expect(specPaths.get("/class/classes")).toEqual({ path: "/class/classes", tag: "Class", methods: ["get"] });
  });
});

describe("spec:coverage — threshold", () => {
  it("defaults to 0 (informational), reads SPEC_COVERAGE_MIN, and --min wins", () => {
    expect(parseThreshold([], {})).toBe(0);
    expect(parseThreshold([], { SPEC_COVERAGE_MIN: "30" })).toBe(30);
    expect(parseThreshold(["--min", "12.5"], { SPEC_COVERAGE_MIN: "30" })).toBe(12.5);
    expect(parseThreshold(["--min=40"], {})).toBe(40);
  });

  it("rejects a threshold that is not a percentage", () => {
    expect(() => parseThreshold(["--min", "abc"], {})).toThrow(/0 to 100/);
    expect(() => parseThreshold(["--min=101"], {})).toThrow(/0 to 100/);
    expect(() => parseThreshold(["--min"], {})).toThrow(/0 to 100/); // a flag with no value is not "no threshold"
  });
});

describe("spec:coverage — the real tree", () => {
  const real = computeCoverage();

  it("maps every registered tool, and most of them to at least one path", () => {
    expect(real.tools.length).toBeGreaterThan(40);
    expect(real.tools.find((t) => t.tool === "getClasses")?.paths).toContain("/class/classes");
    expect(real.tools.find((t) => t.tool === "checkoutShoppingCart")?.paths).toContain("/sale/checkoutshoppingcart");
    expect(real.coveredPaths).toBeGreaterThan(30);
  });

  it("exits 0 by default and 1 below the threshold", () => {
    const run = (...args: string[]) =>
      spawnSync("bun", [join(ROOT, "scripts/spec-coverage.ts"), ...args], { cwd: ROOT, encoding: "utf-8", env: { ...process.env, SPEC_COVERAGE_MIN: "" } });
    const ok = run();
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain(`Summary: ${real.coveredPaths}/${real.totalPaths} spec paths covered`);
    const below = run("--min", "100");
    expect(below.status).toBe(1);
    expect(below.stderr).toContain("below the 100% threshold");
    expect(run("--min", "nope").status).toBe(2);
  }, 30_000);
});
