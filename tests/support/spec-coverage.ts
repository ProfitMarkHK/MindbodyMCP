/**
 * Spec coverage: which docs/openapi.json paths the registered MCP tools reach,
 * and which they do not. Run as `bun run spec:coverage` (scripts/spec-coverage.ts).
 *
 * 1. Call sites come from the Gate 13 scanner (./api-call-scanner), extended with
 *    `.post(<path>)` writes. Nothing here re-implements path resolution.
 * 2. Tools are the object literals in the entry file that carry both `name` and
 *    `inputSchema` (the ListTools list), dispatched by `case '<name>':` clauses.
 * 3. Each tool is mapped to sites by a reference graph over named functions:
 *    from its case clause, every identifier that resolves (through imports) to a
 *    function, method or function-valued const is followed, transitively. A site
 *    belongs to the innermost named function that holds it.
 *
 * The graph over-approximates (a referenced function counts as reached), which
 * suits a coverage report: it can call a path covered that a tool reaches only
 * on some branch, never miss one a tool calls through a named function.
 */
import ts from "typescript";
import { join } from "path";
import {
  type CallSite,
  type Unresolved,
  createProgram,
  listSourceFiles,
  normalisePath,
  readSpec,
  relPosix,
  ROOT,
  scanFile,
} from "./api-call-scanner.js";

const HTTP_VERBS = ["get", "post", "put", "patch", "delete"] as const;

export interface SpecPath {
  /** Path without the `/public/v{version}` prefix, original case. */
  path: string;
  tag: string;
  methods: string[];
}

/** Every spec path, keyed by normalisePath. */
export function loadSpecPaths(spec: any = readSpec()): Map<string, SpecPath> {
  const out = new Map<string, SpecPath>();
  for (const [raw, item] of Object.entries<any>(spec.paths ?? {})) {
    const methods = HTTP_VERBS.filter((m) => item?.[m]);
    if (methods.length === 0) continue;
    const tag = methods.map((m) => item[m].tags?.[0]).find(Boolean) ?? "Untagged";
    out.set(normalisePath(raw), { path: raw.replace(/^\/public\/v\{version\}/i, ""), tag, methods: [...methods] });
  }
  return out;
}

/** The spec key a called path matches: exact, or against a `{param}` template. Null if the spec has no such path. */
export function matchSpecPath(specPaths: Map<string, SpecPath>, path: string): string | null {
  const key = normalisePath(path);
  if (specPaths.has(key)) return key;
  for (const candidate of specPaths.keys()) {
    if (!candidate.includes("{")) continue;
    const pattern = candidate.replace(/[.*+?^$()|[\]\\]/g, "\\$&").replace(/\{[^}]+\}/g, "[^/]+");
    if (new RegExp(`^${pattern}$`).test(key)) return candidate;
  }
  return null;
}

const methodOf = (site: CallSite) => (site.kind === "post" ? "post" : "get");

// ── Tool → call-site mapping ──────────────────────────────────────────────────

type Unit = ts.Node;

/** A named function-like declaration: the unit a reference can reach. */
function isUnit(node: ts.Node): boolean {
  if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node)) return true;
  if (ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) return true;
  if ((ts.isVariableDeclaration(node) || ts.isPropertyAssignment(node) || ts.isPropertyDeclaration(node)) && node.initializer) {
    let init: ts.Expression = node.initializer;
    while (ts.isParenthesizedExpression(init) || ts.isAsExpression(init)) init = init.expression;
    return ts.isArrowFunction(init) || ts.isFunctionExpression(init);
  }
  return false;
}

export interface ToolSites {
  /** Registered tool name → the API call sites it reaches. */
  tools: Map<string, CallSite[]>;
  /** Every site found under the scanned files, reads and writes. */
  allSites: CallSite[];
  /** `.post` calls whose path is not a literal (e.g. the token issue in src/api/auth.ts). */
  unresolvedWrites: Unresolved[];
}

/**
 * Map each tool registered in `entryFile` to the call sites it reaches across `files`.
 * `files` must include `entryFile`.
 */
export function mapToolsToSites(files: string[], entryFile: string, tsconfig = join(ROOT, "tsconfig.json")): ToolSites {
  const program = createProgram(files, tsconfig);
  const checker = program.getTypeChecker();
  const allSites: CallSite[] = [];
  const unresolved: Unresolved[] = [];
  const writes = { sites: [] as CallSite[], unresolved: [] as Unresolved[] };
  for (const file of files) scanFile(program, file, allSites, unresolved, writes);
  allSites.push(...writes.sites);

  // Units per file, and the edges out of each (a unit nested in another is its own unit).
  const edges = new Map<Unit, Set<Unit>>();
  const sitesOf = new Map<Unit, CallSite[]>();
  const unitsByFile = new Map<string, Unit[]>();

  const resolveUnit = (id: ts.Identifier): Unit[] => {
    let sym = checker.getSymbolAtLocation(id);
    if (!sym) return [];
    if (sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
    return (sym.declarations ?? []).filter(isUnit);
  };

  for (const file of files) {
    const sf = program.getSourceFile(file)!;
    const units: Unit[] = [];
    const walk = (node: ts.Node, owner: Unit) => {
      if (isUnit(node)) {
        units.push(node);
        edges.set(node, new Set());
        owner = node;
      }
      if (ts.isIdentifier(node)) for (const target of resolveUnit(node)) if (target !== owner) edges.get(owner)?.add(target);
      ts.forEachChild(node, (child) => walk(child, owner));
    };
    edges.set(sf, new Set());
    walk(sf, sf);
    unitsByFile.set(relPosix(ROOT, file), units);
  }
  // A site belongs to the innermost unit whose range holds it (the file itself if none).
  for (const site of allSites) {
    const units = unitsByFile.get(site.file) ?? [];
    let owner: Unit | undefined;
    for (const u of units) if (site.pos >= u.pos && site.pos < u.end && (!owner || u.pos >= owner.pos)) owner = u;
    if (owner) (sitesOf.get(owner) ?? sitesOf.set(owner, []).get(owner)!).push(site);
  }

  // Tools: `{ name: '<x>', inputSchema: … }` literals, dispatched by `case '<x>':`.
  const entry = program.getSourceFile(entryFile)!;
  const registered = new Set<string>();
  const clauses: ts.CaseClause[] = [];
  const findTools = (node: ts.Node) => {
    if (ts.isObjectLiteralExpression(node)) {
      const props = new Map(
        node.properties.filter(ts.isPropertyAssignment).map((p) => [p.name.getText(entry), p.initializer] as const)
      );
      const name = props.get("name");
      if (props.has("inputSchema") && name && ts.isStringLiteralLike(name)) registered.add(name.text);
    }
    if (ts.isCaseClause(node)) clauses.push(node);
    ts.forEachChild(node, findTools);
  };
  findTools(entry);

  const tools = new Map<string, CallSite[]>();
  for (const name of [...registered].sort()) tools.set(name, []);
  clauses.forEach((clause, i) => {
    if (!ts.isStringLiteralLike(clause.expression) || !registered.has(clause.expression.text)) return;
    // `case 'a': case 'b': …` — an empty clause falls through to the next one with statements.
    let body = clause;
    for (let j = i; body.statements.length === 0 && j + 1 < clauses.length; j++) body = clauses[j + 1];
    const start = new Set<Unit>();
    const direct: CallSite[] = [];
    const collect = (node: ts.Node) => {
      if (ts.isIdentifier(node)) resolveUnit(node).forEach((u) => start.add(u));
      ts.forEachChild(node, collect);
    };
    body.statements.forEach(collect);
    const rel = relPosix(ROOT, entryFile);
    for (const site of allSites) {
      if (site.file === rel && body.statements.some((s) => site.pos >= s.pos && site.pos < s.end)) direct.push(site);
    }
    const seen = new Set<Unit>();
    const queue = [...start];
    while (queue.length) {
      const u = queue.pop()!;
      if (seen.has(u)) continue;
      seen.add(u);
      direct.push(...(sitesOf.get(u) ?? []));
      queue.push(...(edges.get(u) ?? []));
    }
    tools.get(clause.expression.text)!.push(...direct);
  });
  return { tools, allSites, unresolvedWrites: writes.unresolved };
}

// ── Report ────────────────────────────────────────────────────────────────────

export interface CoverageReport {
  totalPaths: number;
  coveredPaths: number;
  /** coveredPaths / totalPaths × 100, unrounded. */
  percent: number;
  byTag: Array<{ tag: string; total: number; covered: number; uncovered: SpecPath[] }>;
  /** Tool → the spec paths it reaches, sorted. */
  tools: Array<{ tool: string; paths: string[] }>;
  /** Tools that reach no API path (local-only, e.g. the pricing map). */
  localTools: string[];
  /** Spec paths called somewhere in the scanned code but reached by no tool. */
  calledButUnreached: string[];
  /** Call sites whose path or method the spec does not define. */
  notInSpec: CallSite[];
}

export function buildCoverage(specPaths: Map<string, SpecPath>, mapping: ToolSites): CoverageReport {
  /** The spec key a site hits, or null when the path or the method is not in the spec. */
  const keyOf = (site: CallSite) => {
    const key = matchSpecPath(specPaths, site.path);
    return key && specPaths.get(key)!.methods.includes(methodOf(site)) ? key : null;
  };
  const covered = new Set<string>();
  const tools = [...mapping.tools].map(([tool, sites]) => {
    const keys = new Set(sites.map(keyOf).filter((k): k is string => k !== null));
    keys.forEach((k) => covered.add(k));
    return { tool, paths: [...keys].map((k) => specPaths.get(k)!.path).sort() };
  });
  const called = new Set(mapping.allSites.map(keyOf).filter((k): k is string => k !== null));
  const tags = new Map<string, { tag: string; total: number; covered: number; uncovered: SpecPath[] }>();
  for (const [key, sp] of specPaths) {
    const row = tags.get(sp.tag) ?? tags.set(sp.tag, { tag: sp.tag, total: 0, covered: 0, uncovered: [] }).get(sp.tag)!;
    row.total++;
    if (covered.has(key)) row.covered++;
    else row.uncovered.push(sp);
  }
  for (const row of tags.values()) row.uncovered.sort((a, b) => a.path.localeCompare(b.path));
  const totalPaths = specPaths.size;
  return {
    totalPaths,
    coveredPaths: covered.size,
    percent: totalPaths === 0 ? 0 : (covered.size / totalPaths) * 100,
    byTag: [...tags.values()].sort((a, b) => a.tag.localeCompare(b.tag)),
    tools: tools.sort((a, b) => a.tool.localeCompare(b.tool)),
    localTools: tools.filter((t) => t.paths.length === 0).map((t) => t.tool).sort(),
    calledButUnreached: [...called].filter((k) => !covered.has(k)).map((k) => specPaths.get(k)!.path).sort(),
    notInSpec: mapping.allSites.filter((s) => keyOf(s) === null),
  };
}

/** The real report: tools registered in src/index.ts, sites across src/, against docs/openapi.json. */
export function computeCoverage(): CoverageReport {
  const files = listSourceFiles(join(ROOT, "src"));
  return buildCoverage(loadSpecPaths(), mapToolsToSites(files, join(ROOT, "src/index.ts")));
}

/**
 * The minimum covered percentage: `--min <n>` / `--min=<n>`, else SPEC_COVERAGE_MIN, else 0
 * (informational). Throws on a value that is not a number from 0 to 100.
 */
export function parseThreshold(argv: string[], env: Record<string, string | undefined>): number {
  let raw: string | undefined = env.SPEC_COVERAGE_MIN;
  argv.forEach((arg, i) => {
    if (arg === "--min") raw = argv[i + 1] ?? "(missing)";
    else if (arg.startsWith("--min=")) raw = arg.slice("--min=".length);
  });
  if (raw === undefined || raw === "") return 0;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 100) throw new Error(`spec:coverage: threshold must be a number from 0 to 100, got "${raw}"`);
  return n;
}

export function formatReport(report: CoverageReport, threshold: number): string {
  const pct = (covered: number, total: number) => (total === 0 ? "0.0" : ((covered / total) * 100).toFixed(1));
  const out: string[] = ["OpenAPI coverage: docs/openapi.json paths reached by registered MCP tools", ""];
  out.push("Tools → spec paths:");
  for (const { tool, paths } of report.tools) out.push(`  ${tool}: ${paths.length ? paths.join(", ") : "(local only, no API call)"}`);
  out.push("", "Uncovered paths by tag:");
  for (const row of report.byTag) {
    out.push(`  ${row.tag} (${row.covered}/${row.total} covered)`);
    for (const sp of row.uncovered) out.push(`    ${sp.methods.map((m) => m.toUpperCase()).join(",").padEnd(10)} ${sp.path}`);
  }
  if (report.calledButUnreached.length) {
    out.push("", "Called in src/ but reached by no registered tool:");
    report.calledButUnreached.forEach((p) => out.push(`  ${p}`));
  }
  if (report.notInSpec.length) {
    out.push("", "Call sites the spec does not define (path or method):");
    report.notInSpec.forEach((s) => out.push(`  ${s.file}:${s.line} → ${s.kind} ${s.path}`));
  }
  out.push(
    "",
    `Summary: ${report.coveredPaths}/${report.totalPaths} spec paths covered (${pct(report.coveredPaths, report.totalPaths)}%), ` +
      `${report.tools.length} tools (${report.localTools.length} local only), threshold ${threshold}%`
  );
  return out.join("\n");
}
