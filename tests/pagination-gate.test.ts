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
 * paginated or not. Every TypeScript file (.ts and .tsx) under src/ AND under
 * nextjs-app/src/ is then scanned (comments blanked out first, line numbers
 * preserved) for API GET call sites:
 *
 *   - `fetchAllPages(<client>, '<path>', …)` — with or without a type argument,
 *     over any number of lines, whatever the first argument (`client`,
 *     `this.client`, …);
 *   - `<client>.get('<path>', …)` / `<client>.get<T>('<path>', …)` with a string
 *     literal starting with '/', on any receiver;
 *   - `client.get(…)` / `mindbodyClient.get(…)` / `this.client.get(…)` with a
 *     NON-literal first argument, and any `.request(…)` on those receivers:
 *     these cannot be resolved to a path, so they fail rule 5 rather than escape
 *     the scan. Two structural exemptions, both located by parsing rather than
 *     by line number: the request issued inside the body of `fetchAllPages`
 *     itself, and the forwarding calls inside the body of `class
 *     MindbodyApiClient` (the HTTP wrapper whose `.get()` hands the path to
 *     axios; its own call sites are what the scan checks).
 *
 * Every rule is its own test, and its failure message lists every offender as
 * `file:line → path`. The suite prints `GATE13_PAGINATION_RESULT sites=N
 * violations=M` from afterAll, consumed by scripts/check-gates.sh. The line is
 * printed only when the scan itself completed, so a crash is fail-closed.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "fs";
import { join, relative, resolve } from "path";

const ROOT = resolve(__dirname, "..");
/** Every directory the scan covers. Add a root here, never an exemption. */
const SCAN_ROOTS = [join(ROOT, "src"), join(ROOT, "nextjs-app/src")];
const SPEC_PATH = join(ROOT, "docs/openapi.json");

/**
 * The number of API GET call sites the scanner finds today, observed
 * 2026-10-17 and cross-checked against an independent grep:
 *
 *   src/            32 — 30 `fetchAllPages` calls + 2 single GETs to the
 *                        non-paginated /class/classvisits and /site/activationcode
 *   nextjs-app/src/ 26 — 25 `fetchAllPages` calls + 1 single GET to the
 *                        non-paginated /site/activationcode
 *
 * A floor, not an exact count: adding endpoints raises the real number freely,
 * but a broken scanner that finds nothing (or a fraction, e.g. one root silently
 * dropped) cannot pass vacuously. Lower it only when call sites are genuinely
 * removed.
 */
const MIN_EXPECTED_SITES = 58;

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

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listSourceFiles(full));
    else if (entry.isFile() && /\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts")) out.push(full);
  }
  return out.sort();
}

/**
 * Replace every comment character with a space (newlines kept), leaving code and
 * string literals intact, so commented-out calls are not counted and offsets map
 * to the same line numbers as the original file.
 */
function blankComments(source: string): string {
  const out = source.split("");
  let i = 0;
  const n = source.length;
  while (i < n) {
    const c = source[i];
    const next = source[i + 1];
    if (c === "/" && next === "/") {
      while (i < n && source[i] !== "\n") out[i++] = " ";
    } else if (c === "/" && next === "*") {
      out[i++] = " ";
      out[i++] = " ";
      while (i < n && !(source[i] === "*" && source[i + 1] === "/")) {
        if (source[i] !== "\n") out[i] = " ";
        i++;
      }
      if (i < n) {
        out[i++] = " ";
        out[i++] = " ";
      }
    } else if (c === "'" || c === '"' || c === "`") {
      i = skipString(source, i);
    } else {
      i++;
    }
  }
  return out.join("");
}

/** Index just past the string literal opening at `start`. Template `${}` nesting is followed. */
function skipString(source: string, start: number): number {
  const quote = source[start];
  let i = start + 1;
  while (i < source.length) {
    const c = source[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === quote) return i + 1;
    if (quote === "`" && c === "$" && source[i + 1] === "{") {
      i = skipBalanced(source, i + 1, "{", "}");
      continue;
    }
    if (quote !== "`" && c === "\n") return i;
    i++;
  }
  return i;
}

/** Index just past the bracket that closes the one at `start`, skipping strings. */
function skipBalanced(source: string, start: number, open: string, close: string): number {
  let depth = 0;
  let i = start;
  while (i < source.length) {
    const c = source[i];
    if (c === "'" || c === '"' || c === "`") {
      i = skipString(source, i);
      continue;
    }
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return i + 1;
    }
    i++;
  }
  return i;
}

function skipWs(source: string, i: number): number {
  while (i < source.length && /\s/.test(source[i])) i++;
  return i;
}

/** Index just past `<…>` at `i` if there is a type argument list there, else `i`. */
function skipTypeArgs(source: string, i: number): number {
  return source[i] === "<" ? skipBalanced(source, i, "<", ">") : i;
}

/** Index of the end of the call argument starting at `i` (top-level `,` or `)`). */
function argEnd(source: string, i: number): number {
  let depth = 0;
  while (i < source.length) {
    const c = source[i];
    if (c === "'" || c === '"' || c === "`") {
      i = skipString(source, i);
      continue;
    }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      if (depth === 0) return i;
      depth--;
    } else if (c === "," && depth === 0) return i;
    i++;
  }
  return i;
}

/** The literal value if the argument at `i` is a plain string literal (no `${}`), else null. */
function literalAt(source: string, i: number): string | null {
  const quote = source[i];
  if (quote !== "'" && quote !== '"' && quote !== "`") return null;
  const end = skipString(source, i);
  const body = source.slice(i + 1, end - 1);
  if (quote === "`" && body.includes("${")) return null;
  const after = skipWs(source, end);
  if (source[after] !== "," && source[after] !== ")") return null;
  return body;
}

function lineOf(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (source[i] === "\n") line++;
  return line;
}

/** [start, end) of the body of `function fetchAllPages`, if this file declares it. */
function pagerBody(code: string): [number, number] | null {
  const decl = /\bfunction\s+fetchAllPages\b/.exec(code);
  if (!decl) return null;
  const params = code.indexOf("(", decl.index);
  const afterParams = skipBalanced(code, params, "(", ")");
  const brace = code.indexOf("{", afterParams);
  // Skip a return-type annotation such as `Promise<{ items: T[] }>` before the body.
  let i = afterParams;
  while (i < code.length && code[i] !== "{") {
    if (code[i] === "<") {
      i = skipBalanced(code, i, "<", ">");
      continue;
    }
    i++;
  }
  const start = i < code.length ? i : brace;
  return [start, skipBalanced(code, start, "{", "}")];
}

/**
 * [start, end) of the body of `class MindbodyApiClient`, if this file declares
 * it. Both code bases wrap axios in a class of that name whose `get()` /
 * `request()` forward a caller-supplied path to `this.client` (the axios
 * instance). Those forwarding calls are the transport, not Mindbody call sites,
 * so they are exempt from rule 5; the wrapper's own callers are what the scan
 * checks. Located by parsing, like the pager body, never by line number.
 */
function wrapperClassBody(code: string): [number, number] | null {
  const decl = /\bclass\s+MindbodyApiClient\b/.exec(code);
  if (!decl) return null;
  const start = code.indexOf("{", decl.index);
  if (start < 0) return null;
  return [start, skipBalanced(code, start, "{", "}")];
}

/**
 * Receivers that are known to be a Mindbody HTTP client: a bare `client` or
 * `mindbodyClient` (the MCP server) or `this.client` (the Next.js service and
 * the wrapper classes). Property access on anything else (`cache.get`,
 * `map.get`) is not a Mindbody call and is ignored when its path is non-literal.
 */
const MINDBODY_CLIENT_RECEIVER = /(?:^|[^\w$.])(client|mindbodyClient|this\s*\.\s*client)\s*$/;

function scanFile(file: string, sites: CallSite[], unresolved: Unresolved[]): void {
  const original = readFileSync(file, "utf-8");
  const code = blankComments(original);
  const rel = relative(ROOT, file);
  const pager = pagerBody(code);
  const wrapper = wrapperClassBody(code);
  const inside = (range: [number, number] | null, index: number) =>
    range !== null && index >= range[0] && index < range[1];
  const insidePager = (index: number) => inside(pager, index) || inside(wrapper, index);

  // fetchAllPages(client, '<path>', …)
  for (const match of code.matchAll(/\bfetchAllPages\b/g)) {
    const at = match.index!;
    if (/\bfunction\s+$/.test(code.slice(Math.max(0, at - 20), at))) continue; // the declaration
    let i = skipWs(code, at + match[0].length);
    i = skipWs(code, skipTypeArgs(code, i));
    if (code[i] !== "(") continue; // an import/export specifier, not a call
    const firstArgEnd = argEnd(code, i + 1);
    if (code[firstArgEnd] !== ",") {
      unresolved.push({ file: rel, line: lineOf(code, at), reason: "fetchAllPages call with no path argument" });
      continue;
    }
    const path = literalAt(code, skipWs(code, firstArgEnd + 1));
    if (path === null || !path.startsWith("/")) {
      unresolved.push({ file: rel, line: lineOf(code, at), reason: "fetchAllPages path is not a string literal starting with '/'" });
      continue;
    }
    sites.push({ kind: "fetchAllPages", file: rel, line: lineOf(code, at), path });
  }

  // <receiver>.get('<path>', …) and <receiver>.get<T>('<path>', …)
  for (const match of code.matchAll(/\.\s*get\b/g)) {
    const at = match.index!;
    let i = skipWs(code, at + match[0].length);
    i = skipWs(code, skipTypeArgs(code, i));
    if (code[i] !== "(") continue;
    const argStart = skipWs(code, i + 1);
    const path = literalAt(code, argStart);
    if (path !== null && path.startsWith("/")) {
      sites.push({ kind: "get", file: rel, line: lineOf(code, at), path });
      continue;
    }
    const receiver = code.slice(Math.max(0, at - 40), at);
    if (MINDBODY_CLIENT_RECEIVER.test(receiver) && !insidePager(at)) {
      unresolved.push({ file: rel, line: lineOf(code, at), reason: "Mindbody client .get() with a non-literal path" });
    }
  }

  // client.request(…) bypasses .get()/fetchAllPages and cannot be classified.
  for (const match of code.matchAll(/\.\s*request\b/g)) {
    const at = match.index!;
    let i = skipWs(code, at + match[0].length);
    i = skipWs(code, skipTypeArgs(code, i));
    if (code[i] !== "(") continue;
    const receiver = code.slice(Math.max(0, at - 40), at);
    if (MINDBODY_CLIENT_RECEIVER.test(receiver) && !insidePager(at)) {
      unresolved.push({ file: rel, line: lineOf(code, at), reason: "Mindbody client .request() bypasses the GET scan" });
    }
  }
}

function scan(): { specGets: Map<string, SpecGet>; sites: CallSite[]; unresolved: Unresolved[] } {
  const specGets = loadSpecGets();
  const sites: CallSite[] = [];
  const unresolved: Unresolved[] = [];
  for (const root of SCAN_ROOTS) for (const file of listSourceFiles(root)) scanFile(file, sites, unresolved);
  return { specGets, sites, unresolved };
}

const describeSite = (site: CallSite) => `${site.file}:${site.line} → ${site.path} (${site.kind})`;

const { specGets, sites, unresolved } = scan();

const singleGetOnPaginated = sites.filter(
  (site) => site.kind === "get" && specGets.get(normalisePath(site.path))?.paginated === true
);
const unknownPaths = sites.filter((site) => !specGets.has(normalisePath(site.path)));
const pagingNonPaginated = sites.filter(
  (site) => site.kind === "fetchAllPages" && specGets.get(normalisePath(site.path))?.paginated === false
);
const sanityShortfall = sites.length < MIN_EXPECTED_SITES ? 1 : 0;
const violations =
  singleGetOnPaginated.length + unknownPaths.length + pagingNonPaginated.length + unresolved.length + sanityShortfall;

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

  it(`rule 4: the scanner found at least ${MIN_EXPECTED_SITES} API GET call sites (no vacuous pass)`, () => {
    expect(specGets.size).toBeGreaterThan(50);
    expect(sites.length).toBeGreaterThanOrEqual(MIN_EXPECTED_SITES);
    expect(sites.some((site) => site.kind === "fetchAllPages")).toBe(true);
    expect(sites.some((site) => site.kind === "get")).toBe(true);
    // Every scan root contributed: a root that is silently dropped (renamed,
    // moved, or filtered out by the file-extension test) must not pass.
    for (const root of SCAN_ROOTS) {
      const prefix = relative(ROOT, root);
      expect(sites.some((site) => site.file.startsWith(prefix)), `no call sites found under ${prefix}/`).toBe(true);
    }
  });

  it("rule 5: every Mindbody GET call site resolves to a literal path the scanner can check", () => {
    expect(
      report("Unresolvable API call site", unresolved.map((u) => `${u.file}:${u.line} → ${u.reason}`))
    ).toBe("");
  });
});

describe("Gate 13 — scanner self-test", () => {
  // Fixtures for the scanner itself, so a regex regression shows up here and not
  // only as a silently lower site count.
  const fixture = [
    "import { fetchAllPages } from '../api/client.js';",
    "// client.get('/class/classes') in a comment is ignored",
    "/* fetchAllPages(client, '/sale/sales', {}, 'Sales') */",
    "const a = await fetchAllPages<any>(",
    "  client,",
    "  '/site/locations',",
    "  {},",
    "  'Locations'",
    ");",
    "const b = await client.get<{ X: number }>(\"/class/classvisits\", { params: {} });",
    "const c = await mindbodyClient",
    "  .get(`/staff/staff`);",
    "const d = cache.get<any>(cacheKey);",
    "const e = await client.get(dynamicPath);",
    "const f = await fetchAllPages(client, `/x/${y}`, {}, 'X');",
    "const g = await client.request({ method: 'GET', url: '/class/classes' });",
    "const h = 'https://example.invalid/not-a-comment'; const i = await client.get('/site/sites');",
    "const j = await fetchAllPages<any>(this.client, '/sale/products', {}, 'Products');",
    "const k = await this.client.get<any>(somePath, { params });",
    "class MindbodyApiClient {",
    "  async get<T>(endpoint: string): Promise<T> { return this.client.get<T>(endpoint); }",
    "  async request<T>(c: any): Promise<T> { return this.client.request<T>(c); }",
    "}",
    "const l = await this.client.get<any>('/site/activationcode');",
  ].join("\n");

  it("finds multi-line, generic and chained calls, ignores comments, flags unresolvable ones", () => {
    const tmp = join(require("os").tmpdir(), `gate13-fixture-${process.pid}.ts`);
    require("fs").writeFileSync(tmp, fixture);
    try {
      const found: CallSite[] = [];
      const bad: Unresolved[] = [];
      scanFile(tmp, found, bad);
      expect(found.map((s) => [s.kind, s.line, s.path])).toEqual([
        ["fetchAllPages", 4, "/site/locations"],
        ["fetchAllPages", 18, "/sale/products"],
        ["get", 10, "/class/classvisits"],
        ["get", 12, "/staff/staff"],
        ["get", 17, "/site/sites"],
        ["get", 24, "/site/activationcode"],
      ]);
      // Line 19 (`this.client.get(somePath)`) is unresolvable; lines 21-22, the
      // forwarding calls inside `class MindbodyApiClient`, are the exempt wrapper.
      expect(bad.map((u) => u.line)).toEqual([15, 14, 19, 16]);
    } finally {
      require("fs").rmSync(tmp, { force: true });
    }
  });

  it("scans .tsx files too", () => {
    const dir = require("fs").mkdtempSync(join(require("os").tmpdir(), "gate13-tsx-"));
    const tmp = join(dir, "page.tsx");
    require("fs").writeFileSync(tmp, "export const x = async () => client.get<any>('/class/classes');\n");
    require("fs").writeFileSync(join(dir, "types.d.ts"), "declare const y: number;\n");
    try {
      expect(listSourceFiles(dir)).toEqual([tmp]); // .tsx is listed, .d.ts is not
      const found: CallSite[] = [];
      scanFile(tmp, found, []);
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
});
