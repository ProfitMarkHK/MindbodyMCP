/**
 * Spec coverage: which docs/openapi.json paths the registered MCP tools reach,
 * and which they do not. Run as `bun run spec:coverage` (scripts/spec-coverage.ts).
 *
 * 1. Call sites come from the Gate 13 scanner (./api-call-scanner), extended with
 *    `.post(<path>)` writes. Nothing here re-implements path resolution.
 * 2. Tools are the object literals in the entry file that carry both `name` and
 *    `inputSchema` (the ListTools list), dispatched by `case '<name>':` clauses.
 * 3. Each tool is mapped to sites by a reference graph over named functions:
 *    from its case clause, every identifier that resolves (through imports, by
 *    syntax: ./source-index) to a
 *    function, method or function-valued const is followed, transitively. A site
 *    belongs to the innermost named function that holds it.
 *
 * The graph over-approximates (a referenced function counts as reached), which
 * suits a coverage report: it can call a path covered that a tool reaches only
 * on some branch, never miss one a tool calls through a named function.
 */
import { join } from "path";
import {
  type CallSite,
  type Unresolved,
  listSourceFiles,
  normalisePath,
  readSpec,
  relPosix,
  ROOT,
  scanFile,
} from "./api-call-scanner.js";
import { type Node, type Source, children, load, referenceOf, walk } from "./source-index.js";

/** Declarations that hold types only: no unit or reference lives inside them. */
const TYPE_ONLY = new Set(["TSInterfaceDeclaration", "TSTypeAliasDeclaration", "TSDeclareFunction", "TSEnumDeclaration"]);

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

type Unit = Node;

/** A named function-like declaration: the unit a reference can reach. */
function isUnit(node: Node): boolean {
  if (node.type === "FunctionDeclaration" || node.type === "MethodDefinition") return true;
  if (node.type === "Property" && (node.method || node.kind === "get" || node.kind === "set")) return true;
  const init =
    node.type === "VariableDeclarator" ? node.init : node.type === "PropertyDefinition" || (node.type === "Property" && !node.shorthand) ? node.value : null;
  let value = init;
  while (value && (value.type === "ParenthesizedExpression" || value.type === "TSAsExpression")) value = value.expression;
  return value?.type === "ArrowFunctionExpression" || value?.type === "FunctionExpression";
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
export function mapToolsToSites(files: string[], entryFile: string): ToolSites {
  const allSites: CallSite[] = [];
  const unresolved: Unresolved[] = [];
  const writes = { sites: [] as CallSite[], unresolved: [] as Unresolved[] };
  for (const file of files) scanFile(file, allSites, unresolved, writes);
  allSites.push(...writes.sites);

  // Units per file, and the edges out of each (a unit nested in another is its own unit).
  const edges = new Map<Unit, Set<Unit>>();
  const sitesOf = new Map<Unit, CallSite[]>();
  const unitsByFile = new Map<string, Unit[]>();

  const resolveUnit = (src: Source, id: Node): Unit[] => {
    const target = referenceOf(src, id);
    return target && isUnit(target.decl) ? [target.decl] : [];
  };
  /** Every identifier under `node` in value position, with the unit that holds it. */
  const walkUnits = (src: Source, node: Node, owner: Unit, units: Unit[]) => {
    if (TYPE_ONLY.has(node.type)) return;
    if (isUnit(node)) {
      units.push(node);
      edges.set(node, new Set());
      owner = node;
    }
    if (node.type === "Identifier") for (const target of resolveUnit(src, node)) if (target !== owner) edges.get(owner)?.add(target);
    for (const child of children(node)) walkUnits(src, child, owner, units);
  };

  for (const file of files) {
    const src = load(file);
    const units: Unit[] = [];
    edges.set(src.program, new Set());
    walkUnits(src, src.program, src.program, units);
    unitsByFile.set(relPosix(ROOT, file), units);
  }
  // A site belongs to the innermost unit whose range holds it (the file itself if none).
  for (const site of allSites) {
    const units = unitsByFile.get(site.file) ?? [];
    let owner: Unit | undefined;
    for (const u of units) if (site.pos >= u.start && site.pos < u.end && (!owner || u.start >= owner.start)) owner = u;
    if (owner) (sitesOf.get(owner) ?? sitesOf.set(owner, []).get(owner)!).push(site);
  }

  // Tools: `{ name: '<x>', inputSchema: … }` literals, dispatched by `case '<x>':`.
  const entry = load(entryFile);
  const stringOf = (node: Node): string | null =>
    node?.type === "Literal" && typeof node.value === "string"
      ? node.value
      : node?.type === "TemplateLiteral" && node.expressions.length === 0
        ? node.quasis[0].value.cooked
        : null;
  const registered = new Set<string>();
  const clauses: Node[] = [];
  walk(entry.program, (node) => {
    if (node.type === "ObjectExpression") {
      const props = new Map<string, Node>();
      for (const p of node.properties) {
        if (p.type === "Property" && !p.computed && !p.method && !p.shorthand && p.key.type === "Identifier") props.set(p.key.name, p.value);
      }
      const name = stringOf(props.get("name"));
      if (props.has("inputSchema") && name !== null) registered.add(name);
    }
    if (node.type === "SwitchCase" && node.test) clauses.push(node);
  });

  const tools = new Map<string, CallSite[]>();
  for (const name of [...registered].sort()) tools.set(name, []);
  const rel = relPosix(ROOT, entryFile);
  clauses.forEach((clause, i) => {
    const name = stringOf(clause.test);
    if (name === null || !registered.has(name)) return;
    // `case 'a': case 'b': …` — an empty clause falls through to the next one with statements.
    let body = clause;
    for (let j = i; body.consequent.length === 0 && j + 1 < clauses.length; j++) body = clauses[j + 1];
    const start = new Set<Unit>();
    const direct: CallSite[] = [];
    for (const statement of body.consequent) {
      walk(statement, (node) => {
        if (node.type === "Identifier") resolveUnit(entry, node).forEach((u) => start.add(u));
      });
    }
    for (const site of allSites) {
      if (site.file === rel && body.consequent.some((s: Node) => site.pos >= s.start && site.pos < s.end)) direct.push(site);
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
    tools.get(name)!.push(...direct);
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
