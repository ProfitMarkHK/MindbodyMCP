/**
 * The Mindbody API call-site scanner shared by Gate 13 (tests/pagination-gate.test.ts)
 * and the spec coverage report (tests/support/spec-coverage.ts, `bun run spec:coverage`).
 *
 * It parses TypeScript with the compiler and classifies every call by the TYPE of
 * its receiver, so a renamed client, an aliased import or a hoisted path constant
 * is read for what it is. The rules built on top of it (what is a violation, what
 * counts as covered) live with each consumer; this module only finds call sites.
 * See the header of tests/pagination-gate.test.ts for every form it recognises.
 *
 * It lives under tests/, outside Gate 13's scan roots (src/, scripts/), because its
 * own `item.get` reads of the spec would otherwise be flagged by the scan it implements.
 */
import { readdirSync, readFileSync } from "fs";
import { dirname, join, relative, resolve, sep } from "path";
import ts from "typescript";

export const ROOT = resolve(__dirname, "../..");
export const SPEC_PATH = join(ROOT, "docs/openapi.json");
/** `relative` with forward slashes on every platform, so gate paths compare the same on Windows. */
export const relPosix = (from: string, to: string) => relative(from, to).split(sep).join("/");

/**
 * Receiver types whose `.get` is a keyed lookup, never a Mindbody HTTP read.
 * Matched on the type's symbol name. A type missing from this list is flagged,
 * not ignored (fail-closed): add a cache or collection type here only when its
 * `.get` provably cannot reach the network.
 */
export const BENIGN_RECEIVER_TYPES = new Set([
  "Map",
  "ReadonlyMap",
  "WeakMap",
  "URLSearchParams",
  "Headers",
  "SimpleCache", // src/cache
]);

const PAGINATION_LIMIT_PARAMS = new Set(["request.limit", "getcoursesrequest.limit"]);
const PAGINATION_OFFSET_PARAMS = new Set(["request.offset", "getcoursesrequest.offset"]);

export interface SpecGet {
  paginated: boolean;
}

/** `post` sites are collected only into the optional write sink of scanFile; Gate 13's sites are reads. */
export type CallKind = "fetchAllPages" | "get" | "post";

export interface CallSite {
  kind: CallKind;
  file: string;
  line: number;
  path: string;
  /** Offset of the call in its source file, for attributing the site to the function that holds it. */
  pos: number;
}

export interface Unresolved {
  file: string;
  line: number;
  reason: string;
}

/** Normalised path: no `/public/v{version}` prefix, lowercase, no trailing slash. */
export function normalisePath(path: string): string {
  return path.replace(/^\/public\/v\{version\}/i, "").replace(/\/+$/, "").toLowerCase();
}

export function readSpec(specPath = SPEC_PATH): any {
  return JSON.parse(readFileSync(specPath, "utf-8"));
}

export function loadSpecGets(spec: any = readSpec()): Map<string, SpecGet> {
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

export function listFiles(dir: string, accept: (name: string) => boolean): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full, accept));
    else if (entry.isFile() && accept(entry.name)) out.push(full);
  }
  return out.sort();
}

export const listSourceFiles = (dir: string) => listFiles(dir, (name) => /\.tsx?$/.test(name) && !name.endsWith(".d.ts"));

/** A Program over `files` under the options of `tsconfig`; diagnostics are never read, only types. */
export function createProgram(files: string[], tsconfig: string): ts.Program {
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

/** Where `.post(<path>, …)` call sites go. Optional: Gate 13 scans reads only and passes none. */
export interface WriteSink {
  sites: CallSite[];
  unresolved: Unresolved[];
}

export function scanFile(
  program: ts.Program,
  file: string,
  sites: CallSite[],
  unresolved: Unresolved[],
  writes?: WriteSink
): void {
  const checker = program.getTypeChecker();
  const sf = program.getSourceFile(file);
  if (!sf) throw new Error(`Gate 13: ${file} is not part of the TypeScript program`);
  const rel = relPosix(ROOT, file);
  const exempt = exemptRanges(sf);
  const isExempt = (node: ts.Node) => exempt.some((r) => node.pos >= r.pos && node.end <= r.end);
  const lineOf = (node: ts.Node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const flag = (node: ts.Node, reason: string) => unresolved.push({ file: rel, line: lineOf(node), reason });
  const site = (kind: CallKind, node: ts.Node, path: string): CallSite => ({
    kind,
    file: rel,
    line: lineOf(node),
    path,
    pos: node.getStart(sf),
  });

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
        else sites.push(site("fetchAllPages", callee, path));
      } else if (ts.isIdentifier(callee) && (callee.text === "fetch" || callee.text === "axios")) {
        // The global fetch (scripts) and a bare axios(config): read the URL like a .get path.
        handled.add(callee);
        const url = callee.text === "fetch" ? pathOf(node.arguments[0]) : null;
        if (url === null) flag(callee, `${callee.text}() with a URL the scanner cannot resolve to a literal`);
        else {
          // A Mindbody URL or a '/…' path; any other host is not a Mindbody read. The public spec document is not a site read.
          const path = /^(?:https?:\/\/[^/]*mindbodyonline\.com(?:\/public\/v\d+)?)?(\/[^?#]*)/.exec(url)?.[1];
          if (path && normalisePath(path) !== "/swagger/doc") sites.push(site("get", callee, path));
        }
      } else if (member && HTTP_METHODS.has(member.name)) {
        handled.add(member.node);
        if (!isExempt(node) && !isBenign(member.receiver)) {
          const path = member.name === "get" ? pathOf(node.arguments[0]) : null;
          if (path !== null && path.startsWith("/")) sites.push(site("get", member.at, path));
          else flag(member.at, `.${member.name}() on a receiver that is not a Map or cache, with no literal '/…' path the scanner can check`);
        }
      } else if (writes && member && member.name === "post" && !isExempt(node) && !isBenign(member.receiver)) {
        const path = pathOf(node.arguments[0]);
        if (path !== null && path.startsWith("/")) writes.sites.push(site("post", member.at, path));
        else writes.unresolved.push({ file: rel, line: lineOf(member.at), reason: ".post() with no literal '/…' path" });
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

export function scanFiles(files: string[], tsconfig: string): { sites: CallSite[]; unresolved: Unresolved[] } {
  const sites: CallSite[] = [];
  const unresolved: Unresolved[] = [];
  const program = createProgram(files, tsconfig);
  for (const file of files) scanFile(program, file, sites, unresolved);
  return { sites, unresolved };
}
