/**
 * Gate 13 — mandatory pagination (static, deterministic, no network).
 *
 * Policy: every Mindbody GET endpoint that accepts `request.limit` AND
 * `request.offset` in docs/openapi.json MUST be called through `fetchAllPages`
 * (src/api/client.ts for the MCP server, nextjs-app/src/lib/mindbody/paging.ts
 * for the Next.js app — same name, same semantics). A paginated endpoint called
 * with a single GET is a failure. There is no allowlist.
 *
 * How it works: docs/openapi.json is loaded and every GET path is classified as
 * paginated or not. Every TypeScript file (.ts and .tsx) under each scan root is
 * then parsed with the TypeScript compiler (one Program per root, using that
 * root's own tsconfig so `@/` imports resolve) and every call is classified by
 * the TYPE of its receiver, not by the identifier it happens to be bound to:
 *
 *   - `fetchAllPages(<client>, <path>, …)`, however it is imported or aliased
 *     (`import { fetchAllPages as pageAll }`, `paging.fetchAllPages(…)`);
 *   - `<receiver>.get(<path>, …)`, `<receiver>?.get(…)`, `<receiver>['get'](…)`
 *     and `(<receiver>.get as any)(…)`, on any receiver whose type is not a
 *     known benign one. The path is resolved by type, so a hoisted
 *     `const PATH = '/class/classes'` counts as the literal it is;
 *   - the global `fetch(<url>)` (scripts) and a bare `axios(…)`: a Mindbody URL
 *     or '/…' path is a call site like a `.get`; the public spec document
 *     (`/swagger/doc`) is not a site read; a URL that is not a literal fails;
 *   - when the path does not resolve to a literal starting with '/', the call
 *     cannot be classified, so it fails rule 5 rather than escape the scan; the
 *     same goes for any `.request(…)` and for `.get` / `.request` / `fetchAllPages`
 *     taken as a value (`const g = client.get`, `client.get.bind(client)`).
 *
 * Benign receivers (BENIGN_RECEIVER_TYPES) are the types whose `.get` is a keyed
 * lookup, never an HTTP read: `Map`, `URLSearchParams`, `Headers` and this repo's
 * own TTL caches. Fail-closed: a receiver typed `any`, an axios object, or any
 * type not on that list is treated as a possible Mindbody client. So a path-keyed
 * `routeTable.get('/class/classes')` on a `Map` is ignored on purpose, while the
 * same call on a renamed client, an aliased import or `this.mindbody` is not.
 * Two structural exemptions, both located by parsing rather than by line number:
 * the request issued inside the body of `fetchAllPages` itself, and the
 * forwarding calls inside the body of `class MindbodyApiClient` (the HTTP wrapper
 * whose `.get()` hands the path to axios; its own call sites are what the scan
 * checks).
 *
 * Code outside the TypeScript roots cannot be parsed: rule 6 holds shell scripts
 * under scripts/, nextjs-app/prisma/ and the Next.js app's top-level config files
 * to "no network client or absolute URL on a non-comment line".
 *
 * Every rule is its own test, and its failure message lists every offender as
 * `file:line → path`. The suite prints `GATE13_PAGINATION_RESULT sites=N
 * violations=M` from afterAll, consumed by scripts/check-gates.sh. The line is
 * printed only when the scan itself completed, so a crash is fail-closed.
 *
 * The scanner self-test runs the same scanner over tests/fixtures/gate13/, which
 * sits outside every scan root: one fixture per known escape asserts the gate
 * goes red on it.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "fs";
import { dirname, join, relative, resolve, sep } from "path";
import ts from "typescript";

const ROOT = resolve(__dirname, "..");
/** `relative` with forward slashes on every platform, so gate paths compare the same on Windows. */
const relPosix = (from: string, to: string) => relative(from, to).split(sep).join("/");
/**
 * Every directory the scan covers, with the tsconfig its imports resolve under
 * and `minSites`, the number of API GET call sites it holds today. Add a root
 * here, never an exemption.
 *
 * `minSites` is a per-root floor, not an exact count: adding endpoints raises the
 * real number freely, but a broken scanner that finds nothing (or a fraction, or
 * loses one root) cannot pass vacuously, and a call site that is deleted or
 * turned into a read the scanner cannot see drops a root below its floor.
 *
 * How the numbers were obtained: run `bun test tests/pagination-gate.test.ts` and
 * read the `GATE13_PAGINATION_ROOTS` line it prints (found/floor per root), 2026-10-19:
 *
 *   src/            40 — 38 `fetchAllPages` calls + 2 single GETs to the
 *                        non-paginated /class/classvisits and /site/activationcode
 *   nextjs-app/src/ 28 — 27 `fetchAllPages` calls + 1 single GET to the
 *                        non-paginated /site/activationcode
 *   scripts/         0 — holds no Mindbody read; rule 4 still requires it to be scanned
 *
 * Revisit when the line shows found != floor: lower a floor only when call sites
 * are genuinely removed. The floor going stale is itself a failure (rule 4,
 * ROOT_FLOOR_SLACK), so it cannot quietly drift 10 sites behind, as 58 did.
 */
const SCAN_ROOTS = [
  { dir: join(ROOT, "src"), tsconfig: join(ROOT, "tsconfig.json"), minSites: 40 },
  { dir: join(ROOT, "nextjs-app/src"), tsconfig: join(ROOT, "nextjs-app/tsconfig.json"), minSites: 28 },
  { dir: join(ROOT, "scripts"), tsconfig: join(ROOT, "tsconfig.json"), minSites: 0 }, // .ts only; .sh is rule 6
];
/** How far above its floor a root may sit before the floor counts as stale and must be raised. */
const ROOT_FLOOR_SLACK = 5;
const FIXTURE_DIR = join(ROOT, "tests/fixtures/gate13");
const SPEC_PATH = join(ROOT, "docs/openapi.json");

/**
 * Receiver types whose `.get` is a keyed lookup, never a Mindbody HTTP read.
 * Matched on the type's symbol name. A type missing from this list is flagged,
 * not ignored (fail-closed): add a cache or collection type here only when its
 * `.get` provably cannot reach the network.
 */
const BENIGN_RECEIVER_TYPES = new Set([
  "Map",
  "ReadonlyMap",
  "WeakMap",
  "URLSearchParams",
  "Headers",
  "SimpleCache", // src/cache
  "SimpleTtlCache", // nextjs-app/src/lib/mindbody/siteTime.ts
  "TtlCache", // same file, the interface
]);

const PAGINATION_LIMIT_PARAMS = new Set(["request.limit", "getcoursesrequest.limit"]);
const PAGINATION_OFFSET_PARAMS = new Set(["request.offset", "getcoursesrequest.offset"]);

interface SpecGet {
  paginated: boolean;
}

type CallKind = "fetchAllPages" | "get";

interface CallSite {
  kind: CallKind;
  file: string;
  line: number;
  path: string;
}

interface Unresolved {
  file: string;
  line: number;
  reason: string;
}

/** Normalised path: no `/public/v{version}` prefix, lowercase, no trailing slash. */
function normalisePath(path: string): string {
  return path.replace(/^\/public\/v\{version\}/i, "").replace(/\/+$/, "").toLowerCase();
}

function loadSpecGets(): Map<string, SpecGet> {
  const spec = JSON.parse(readFileSync(SPEC_PATH, "utf-8"));
  const gets = new Map<string, SpecGet>();
  for (const [path, item] of Object.entries<any>(spec.paths ?? {})) {
    if (!item?.get) continue;
    const names = new Set<string>((item.get.parameters ?? []).map((p: any) => String(p.name).toLowerCase()));
    const hasLimit = [...names].some((n) => PAGINATION_LIMIT_PARAMS.has(n));
    const hasOffset = [...names].some((n) => PAGINATION_OFFSET_PARAMS.has(n));
    gets.set(normalisePath(path), { paginated: hasLimit && hasOffset });
  }
  return gets;
}

function listFiles(dir: string, accept: (name: string) => boolean): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full, accept));
    else if (entry.isFile() && accept(entry.name)) out.push(full);
  }
  return out.sort();
}

const listSourceFiles = (dir: string) => listFiles(dir, (name) => /\.tsx?$/.test(name) && !name.endsWith(".d.ts"));

/**
 * Code outside the TypeScript roots that the scanner cannot parse: shell scripts,
 * the Prisma schema and the Next.js app's top-level config files (not `src/`).
 * Rule 6 holds them to "no network client", the explicit counterpart of the roots.
 */
function listUnparsedCode(root: string): string[] {
  const nextjs = join(root, "nextjs-app");
  return [
    ...listFiles(join(root, "scripts"), (name) => name.endsWith(".sh")),
    ...listFiles(join(nextjs, "prisma"), () => true),
    ...readdirSync(nextjs, { withFileTypes: true })
      .filter((e) => e.isFile() && /\.(?:[cm]?[jt]sx?)$/.test(e.name))
      .map((e) => join(nextjs, e.name))
      .sort(),
  ];
}

/** A network client or an absolute URL on any non-comment line. A comment cannot run, so full-line comments are skipped. */
const NETWORK_CLIENT = /\b(?:curl|wget|ncat|socat|telnet|fetch|axios|XMLHttpRequest)\b|\/dev\/tcp\/|https?:\/\/|mindbodyonline/i;

function networkOffenders(files: string[]): string[] {
  const out: string[] = [];
  for (const file of files) {
    readFileSync(file, "utf-8")
      .split("\n")
      .forEach((text, i) => {
        if (/^\s*(?:#|\/\/|\/?\*)/.test(text) || !NETWORK_CLIENT.test(text)) return;
        out.push(`${relPosix(ROOT, file)}:${i + 1} → ${text.trim()}`);
      });
  }
  return out;
}

/** A Program over `files` under the options of `tsconfig`; diagnostics are never read, only types. */
function createProgram(files: string[], tsconfig: string): ts.Program {
  const config = ts.readConfigFile(tsconfig, ts.sys.readFile);
  const { options } = ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(tsconfig), undefined, tsconfig);
  return ts.createProgram(files, {
    ...options,
    noEmit: true,
    incremental: false,
    composite: false,
    declaration: false,
    declarationMap: false,
    sourceMap: false,
    rootDir: undefined,
    outDir: undefined,
    allowJs: false,
    types: [],
  });
}

/** Strip parentheses, casts, `!` and `satisfies`, so `(client.get as any)(…)` reads as `client.get(…)`. */
function unwrap(node: ts.Expression): ts.Expression {
  while (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isSatisfiesExpression(node)
  ) {
    node = node.expression;
  }
  return node;
}

const HTTP_METHODS = new Set(["get", "request"]);

/** `recv.get`, `recv?.get` and `recv['get']`, cast or parenthesised; null for anything else. */
function memberOf(expr: ts.Expression): { name: string; receiver: ts.Expression; node: ts.Expression; at: ts.Node } | null {
  const node = unwrap(expr);
  if (ts.isPropertyAccessExpression(node)) return { name: node.name.text, receiver: node.expression, node, at: node.name };
  if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) {
    return { name: node.argumentExpression.text, receiver: node.expression, node, at: node.argumentExpression };
  }
  return null;
}

/** [fetchAllPages body, class MindbodyApiClient body] of this file: the transport, exempt from rule 5. */
function exemptRanges(sf: ts.SourceFile): ts.Node[] {
  const out: ts.Node[] = [];
  const walk = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === "fetchAllPages" && node.body) out.push(node.body);
    else if (ts.isClassDeclaration(node) && node.name?.text === "MindbodyApiClient") out.push(node);
    ts.forEachChild(node, walk);
  };
  walk(sf);
  return out;
}

function scanFile(
  program: ts.Program,
  file: string,
  sites: CallSite[],
  unresolved: Unresolved[]
): void {
  const checker = program.getTypeChecker();
  const sf = program.getSourceFile(file);
  if (!sf) throw new Error(`Gate 13: ${file} is not part of the TypeScript program`);
  const rel = relPosix(ROOT, file);
  const exempt = exemptRanges(sf);
  const isExempt = (node: ts.Node) => exempt.some((r) => node.pos >= r.pos && node.end <= r.end);
  const lineOf = (node: ts.Node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const flag = (node: ts.Node, reason: string) => unresolved.push({ file: rel, line: lineOf(node), reason });

  /** Type-directed: is this receiver a Map/cache-like type whose `.get` is never an HTTP read? */
  const isBenign = (receiver: ts.Expression) => {
    const type = checker.getNonNullableType(checker.getTypeAtLocation(receiver));
    const parts = type.isUnion() ? type.types : [type];
    return parts.every((t) => BENIGN_RECEIVER_TYPES.has((t.getSymbol() ?? t.aliasSymbol)?.name ?? ""));
  };

  /** The literal a path argument resolves to: a literal, or a const/`as const` whose type is one. */
  const pathOf = (arg: ts.Expression | undefined): string | null => {
    if (!arg) return null;
    const node = unwrap(arg);
    if (ts.isStringLiteralLike(node)) return node.text;
    const type = checker.getTypeAtLocation(node);
    return type.isStringLiteral() ? type.value : null;
  };

  /** `fetchAllPages`, `paging.fetchAllPages`, or an import alias of it. */
  const isPager = (expr: ts.Expression) => {
    const node = unwrap(expr);
    if (ts.isPropertyAccessExpression(node)) return node.name.text === "fetchAllPages";
    if (!ts.isIdentifier(node)) return false;
    if (node.text === "fetchAllPages") return true;
    const decl = checker.getSymbolAtLocation(node)?.declarations?.[0];
    return !!decl && ts.isImportSpecifier(decl) && (decl.propertyName ?? decl.name).text === "fetchAllPages";
  };

  const handled = new Set<ts.Node>(); // callees, so the value-reference rules do not re-flag them

  const visit = (node: ts.Node): void => {
    if (ts.isJSDoc(node)) return;

    if (ts.isCallExpression(node)) {
      const callee = unwrap(node.expression);
      const member = memberOf(node.expression);
      if (isPager(node.expression)) {
        handled.add(callee);
        if (ts.isPropertyAccessExpression(callee)) handled.add(callee.name);
        const path = node.arguments.length < 2 ? null : pathOf(node.arguments[1]);
        if (node.arguments.length < 2) flag(callee, "fetchAllPages call with no path argument");
        else if (path === null || !path.startsWith("/")) flag(callee, "fetchAllPages path is not a string literal starting with '/'");
        else sites.push({ kind: "fetchAllPages", file: rel, line: lineOf(callee), path });
      } else if (ts.isIdentifier(callee) && (callee.text === "fetch" || callee.text === "axios")) {
        // The global fetch (scripts) and a bare axios(config): read the URL like a .get path.
        handled.add(callee);
        const url = callee.text === "fetch" ? pathOf(node.arguments[0]) : null;
        if (url === null) flag(callee, `${callee.text}() with a URL the scanner cannot resolve to a literal`);
        else {
          // A Mindbody URL or a '/…' path; any other host is not a Mindbody read. The public spec document is not a site read.
          const path = /^(?:https?:\/\/[^/]*mindbodyonline\.com(?:\/public\/v\d+)?)?(\/[^?#]*)/.exec(url)?.[1];
          if (path && normalisePath(path) !== "/swagger/doc") sites.push({ kind: "get", file: rel, line: lineOf(callee), path });
        }
      } else if (member && HTTP_METHODS.has(member.name)) {
        handled.add(member.node);
        if (!isExempt(node) && !isBenign(member.receiver)) {
          const path = member.name === "get" ? pathOf(node.arguments[0]) : null;
          if (path !== null && path.startsWith("/")) sites.push({ kind: "get", file: rel, line: lineOf(member.at), path });
          else flag(member.at, `.${member.name}() on a receiver that is not a Map or cache, with no literal '/…' path the scanner can check`);
        }
      }
    } else if (ts.isIdentifier(node) && !handled.has(node) && isPager(node)) {
      const parent = node.parent;
      const declaration = ts.isFunctionDeclaration(parent) && parent.name === node;
      if (!declaration && !ts.isImportSpecifier(parent) && !ts.isExportSpecifier(parent) && !ts.isPropertyAccessExpression(parent)) {
        flag(node, "fetchAllPages used as a value, not called");
      }
    } else if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const member = memberOf(node);
      if (member && HTTP_METHODS.has(member.name) && !handled.has(node) && !isExempt(node) && !isBenign(member.receiver)) {
        flag(member.at, `.${member.name} taken as a value (alias, bind or call) escapes the scan`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

function scanFiles(files: string[], tsconfig: string): { sites: CallSite[]; unresolved: Unresolved[] } {
  const sites: CallSite[] = [];
  const unresolved: Unresolved[] = [];
  const program = createProgram(files, tsconfig);
  for (const file of files) scanFile(program, file, sites, unresolved);
  return { sites, unresolved };
}

function scan() {
  const specGets = loadSpecGets();
  const sites: CallSite[] = [];
  const unresolved: Unresolved[] = [];
  const fileCounts: number[] = [];
  for (const root of SCAN_ROOTS) {
    const files = listSourceFiles(root.dir);
    const found = scanFiles(files, root.tsconfig);
    fileCounts.push(files.length);
    sites.push(...found.sites);
    unresolved.push(...found.unresolved);
  }
  return { specGets, sites, unresolved, fileCounts };
}

const describeSite = (site: CallSite) => `${site.file}:${site.line} → ${site.path} (${site.kind})`;

/** Rules 1, 2, 3 and 5 for a set of scan results (rule 4 is about the real roots only). */
function classify(specGets: Map<string, SpecGet>, sites: CallSite[], unresolved: Unresolved[]) {
  return {
    singleGetOnPaginated: sites.filter((s) => s.kind === "get" && specGets.get(normalisePath(s.path))?.paginated === true),
    unknownPaths: sites.filter((s) => !specGets.has(normalisePath(s.path))),
    pagingNonPaginated: sites.filter((s) => s.kind === "fetchAllPages" && specGets.get(normalisePath(s.path))?.paginated === false),
    unresolved,
  };
}

const { specGets, sites, unresolved, fileCounts } = scan();
const unparsedOffenders = networkOffenders(listUnparsedCode(ROOT));

const { singleGetOnPaginated, unknownPaths, pagingNonPaginated } = classify(specGets, sites, unresolved);
const rootCounts = SCAN_ROOTS.map((root) => {
  const prefix = `${relPosix(ROOT, root.dir)}/`;
  return { prefix, floor: root.minSites, found: sites.filter((site) => site.file.startsWith(prefix)).length };
});
const rootsBelowFloor = rootCounts.filter((r) => r.found < r.floor);
const emptyRoots = rootCounts.filter((_, i) => fileCounts[i] === 0);
const rootsWithStaleFloor = rootCounts.filter((r) => r.found > r.floor + ROOT_FLOOR_SLACK);
const violations =
  singleGetOnPaginated.length +
  unknownPaths.length +
  pagingNonPaginated.length +
  unresolved.length +
  rootsBelowFloor.length +
  rootsWithStaleFloor.length +
  emptyRoots.length +
  unparsedOffenders.length;
const describeRoots = () => rootCounts.map((r) => `${r.prefix} found ${r.found}, floor ${r.floor}`).join("; ");

function report(title: string, offenders: string[]): string {
  return offenders.length === 0 ? "" : `${title}:\n  ${offenders.join("\n  ")}`;
}

describe("Gate 13 — mandatory pagination", () => {
  it("rule 1: no paginated endpoint is called with a single .get() (must use fetchAllPages)", () => {
    expect(
      report(
        "Paginated in docs/openapi.json but called with a single GET — use fetchAllPages",
        singleGetOnPaginated.map(describeSite)
      )
    ).toBe("");
  });

  it("rule 2: every GET path used in src/ and nextjs-app/src/ exists as a GET in docs/openapi.json", () => {
    expect(report("GET path not found in docs/openapi.json", unknownPaths.map(describeSite))).toBe("");
  });

  it("rule 3: fetchAllPages is only used on endpoints the spec paginates", () => {
    expect(
      report(
        "fetchAllPages used on an endpoint with no request.limit/request.offset in docs/openapi.json",
        pagingNonPaginated.map(describeSite)
      )
    ).toBe("");
  });

  it("rule 4: every scan root holds at least its floor of API GET call sites (no vacuous pass)", () => {
    expect(specGets.size).toBeGreaterThan(50);
    expect(sites.some((site) => site.kind === "fetchAllPages")).toBe(true);
    expect(sites.some((site) => site.kind === "get")).toBe(true);
    // Checked per root, independently of the total: a root silently dropped
    // (renamed, moved, filtered out by the file-extension test) or a call site
    // deleted or turned into an unscannable read must not pass.
    expect(
      report("Scan root below its floor", rootsBelowFloor.map((r) => `${r.prefix} found ${r.found}, floor ${r.floor}`)),
      describeRoots()
    ).toBe("");
    // A root with no files to parse (directory renamed, extension filter wrong) is a root not scanned, whatever its floor.
    expect(report("Scan root with no source files", emptyRoots.map((r) => r.prefix))).toBe("");
  });

  it(`rule 4: no floor is stale (a root more than ${ROOT_FLOOR_SLACK} sites above its floor needs the floor raised)`, () => {
    expect(
      report(
        "Floor is stale — raise minSites in SCAN_ROOTS to the found count",
        rootsWithStaleFloor.map((r) => `${r.prefix} found ${r.found}, floor ${r.floor}`)
      )
    ).toBe("");
  });

  it("rule 5: every Mindbody GET call site resolves to a literal path the scanner can check", () => {
    expect(
      report("Unresolvable API call site", unresolved.map((u) => `${u.file}:${u.line} → ${u.reason}`))
    ).toBe("");
  });
});

describe("Gate 13 — code outside the scan roots", () => {
  it("rule 6: shell scripts, the Prisma schema and the Next.js app's config files carry no network client", () => {
    const files = listUnparsedCode(ROOT);
    // Not vacuous: the runner and the live-tier launcher are in the list.
    expect(files.map((f) => relPosix(ROOT, f))).toEqual(
      expect.arrayContaining(["scripts/check-gates.sh", "scripts/live-e2e.sh", "nextjs-app/prisma/schema.prisma"])
    );
    expect(report("Network client outside the scan roots", unparsedOffenders)).toBe("");
  });
});

describe("Gate 13 — scanner self-test", () => {
  // The scanner run over tests/fixtures/gate13/ (outside every scan root, so the
  // real gate never sees them). A regression in the scanner shows up here, not
  // only as a silently lower site count.
  const fixtureProgram = createProgram(listSourceFiles(FIXTURE_DIR), join(ROOT, "tsconfig.json"));
  const scanFixture = (name: string) => {
    const found: CallSite[] = [];
    const bad: Unresolved[] = [];
    scanFile(fixtureProgram, join(FIXTURE_DIR, name), found, bad);
    return { found, bad, tally: classify(specGets, found, bad) };
  };
  const lines = (items: { line: number }[]) => items.map((i) => i.line).sort((a, b) => a - b);

  // One fixture per way a Mindbody read used to slip past the scanner: each must fail the gate.
  const escapes: Array<[fixture: string, rule: "rule 1" | "rule 5"]> = [
    ["escape-renamed-receiver.ts", "rule 1"], // api.get(HOISTED_PATH) on a renamed parameter
    ["escape-renamed-receiver-dynamic.ts", "rule 5"], // c.get(`/class/${id}`)
    ["escape-aliased-import.ts", "rule 1"], // import { mindbodyClient as mb }
    ["escape-this-mindbody.ts", "rule 5"], // this.mindbody.get(path)
    ["escape-computed-member.ts", "rule 1"], // client['get']('/class/classes')
    ["escape-cast-call.ts", "rule 1"], // (client.get as any)('/class/classes')
    ["escape-method-reference.ts", "rule 5"], // client.get.bind(client)
    ["escape-pager-as-value.ts", "rule 5"], // const page = fetchAllPages
    ["escape-fetch-mindbody.ts", "rule 1"], // fetch(HOISTED_MINDBODY_URL), as a script would
    ["escape-fetch-dynamic.ts", "rule 5"], // fetch(url)
  ];
  for (const [fixture, rule] of escapes) {
    it(`goes red on ${fixture} (${rule})`, () => {
      const { tally } = scanFixture(fixture);
      const offenders = rule === "rule 1" ? tally.singleGetOnPaginated : tally.unresolved;
      expect(offenders.length, `${fixture} must be flagged under ${rule}`).toBeGreaterThan(0);
    });
  }

  it("keeps catching the forms it always caught", () => {
    const { found, bad, tally } = scanFixture("still-caught.ts");
    // axios.get, client?.get, and a receiver-newline-then-.get on a paginated path.
    expect(lines(tally.singleGetOnPaginated)).toEqual([5, 6, 8]);
    // fetchAllPages imported as `pageAll`, on a path the spec does not paginate.
    expect(lines(tally.pagingNonPaginated)).toEqual([9]);
    // client.get(dynamicPath)
    expect(lines(bad)).toEqual([10]);
    expect(found).toHaveLength(4);
  });

  it("finds multi-line, generic and chained calls and ignores comments", () => {
    const { found, bad } = scanFixture("ok-forms.ts");
    expect(found.map((s) => [s.kind, s.line, s.path])).toEqual([
      ["fetchAllPages", 5, "/site/locations"],
      ["get", 11, "/class/classvisits"],
      ["get", 13, "/site/activationcode"],
      ["get", 14, "/site/sites"],
    ]);
    expect(bad).toEqual([]);
  });

  it("ignores path-keyed lookups on a Map or a cache (the routeTable.get('/class/classes') false positive)", () => {
    const { found, bad } = scanFixture("ok-route-table.ts");
    expect([found, bad]).toEqual([[], []]);
  });

  it("exempts the transport: the body of fetchAllPages and of class MindbodyApiClient, found by parsing", () => {
    const { found, bad } = scanFixture("ok-exempt-wrapper.ts");
    expect(found.map((s) => [s.kind, s.path])).toEqual([["get", "/site/activationcode"]]); // the wrapper's caller is still scanned
    expect(bad).toEqual([]);
  });

  it("does not treat fetching the public spec document as a site read", () => {
    const { found, bad } = scanFixture("ok-fetch-swagger.ts");
    expect([found, bad]).toEqual([[], []]);
  });

  it("rule 6 detector: flags a network client on a live line, ignores comments", () => {
    const dir = require("fs").mkdtempSync(join(require("os").tmpdir(), "gate13-sh-"));
    const quiet = join(dir, "quiet.sh");
    const loud = join(dir, "loud.sh");
    require("fs").writeFileSync(quiet, "# curl -s https://api.mindbodyonline.com/public/v6/class/classes\nbun test\n");
    require("fs").writeFileSync(loud, "bun test\ncurl -s https://api.mindbodyonline.com/public/v6/class/classes\n");
    try {
      expect(networkOffenders([quiet])).toEqual([]);
      expect(networkOffenders([loud]).map((o) => o.replace(/^.*loud\.sh/, "loud.sh").split(" → ")[0])).toEqual(["loud.sh:2"]);
    } finally {
      require("fs").rmSync(dir, { recursive: true, force: true });
    }
  });

  it("scans .tsx files too", () => {
    const dir = require("fs").mkdtempSync(join(require("os").tmpdir(), "gate13-tsx-"));
    const tmp = join(dir, "page.tsx");
    require("fs").writeFileSync(tmp, "declare const client: any;\nexport const x = async () => client.get<any>('/class/classes');\n");
    require("fs").writeFileSync(join(dir, "types.d.ts"), "declare const y: number;\n");
    try {
      expect(listSourceFiles(dir)).toEqual([tmp]); // .tsx is listed, .d.ts is not
      const { sites: found } = scanFiles([tmp], join(ROOT, "tsconfig.json"));
      expect(found.map((s) => s.path)).toEqual(["/class/classes"]);
    } finally {
      require("fs").rmSync(dir, { recursive: true, force: true });
    }
  });

  it("classifies spec pagination from request.limit + request.offset", () => {
    expect(specGets.get("/class/classes")?.paginated).toBe(true);
    expect(specGets.get("/class/courses")?.paginated).toBe(true); // getCoursesRequest.limit/offset
    expect(specGets.get("/class/classvisits")?.paginated).toBe(false);
    expect(specGets.get("/site/activationcode")?.paginated).toBe(false);
    expect(specGets.has("/client/clientenrollments")).toBe(false);
  });
});

afterAll(() => {
  // Consumed by scripts/check-gates.sh (Gate 13). Keep the two in step.
  console.log(`GATE13_PAGINATION_RESULT sites=${sites.length} violations=${violations}`);
  // Informational, for recounting the floors (not parsed by the runner).
  console.log(`GATE13_PAGINATION_ROOTS ${rootCounts.map((r) => `${r.prefix}=${r.found}/${r.floor}`).join(" ")} (found/floor)`);
});
