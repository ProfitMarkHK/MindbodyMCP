/**
 * The Mindbody API call-site scanner shared by Gate 13 (tests/pagination-gate.test.ts)
 * and the spec coverage report (tests/support/spec-coverage.ts, `bun run spec:coverage`).
 *
 * It parses TypeScript with oxc-parser (./source-index, no TypeScript compiler API)
 * and classifies every call by the declared type of its receiver, read from the
 * code's own declarations, so a renamed client, an aliased import or a hoisted path
 * constant is read for what it is. A receiver whose type it cannot resolve is
 * treated as a possible Mindbody client (fail-closed). The rules built on top of it (what is a violation, what
 * counts as covered) live with each consumer; this module only finds call sites.
 * See the header of tests/pagination-gate.test.ts for every form it recognises.
 *
 * It lives under tests/, outside Gate 13's scan roots (src/, scripts/), because its
 * own `item.get` reads of the spec would otherwise be flagged by the scan it implements.
 */
import { readdirSync, readFileSync } from "fs";
import { join, relative, resolve, sep } from "path";
import { type Node, type Source, constString, kindOf, lineOf, load, lookup, memberName, unwrap, walk } from "./source-index.js";

export const ROOT = resolve(__dirname, "../..");
export const SPEC_PATH = join(ROOT, "docs/openapi.json");
/** `relative` with forward slashes on every platform, so gate paths compare the same on Windows. */
export const relPosix = (from: string, to: string) => relative(from, to).split(sep).join("/");

/**
 * Receiver types whose `.get` is a keyed lookup, never a Mindbody HTTP read.
 * Matched on the declared type name (annotation, `new X`, declared return type). A type missing from this list is flagged,
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

const HTTP_METHODS = new Set(["get", "request"]);

/** `recv.get`, `recv?.get` and `recv['get']`, cast or parenthesised; null for anything else. */
function memberOf(expr: Node): { name: string; receiver: Node; node: Node; at: Node } | null {
  const node = unwrap(expr);
  const name = memberName(node);
  return name === null ? null : { name, receiver: node.object, node, at: node.property };
}

/** [fetchAllPages body, class MindbodyApiClient body] of this file: the transport, exempt from rule 5. */
function exemptRanges(src: Source): Node[] {
  const out: Node[] = [];
  walk(src.program, (node) => {
    if (node.type === "FunctionDeclaration" && node.id?.name === "fetchAllPages" && node.body) out.push(node.body);
    else if (node.type === "ClassDeclaration" && node.id?.name === "MindbodyApiClient") out.push(node);
  });
  return out;
}

/** Where `.post(<path>, …)` call sites go. Optional: Gate 13 scans reads only and passes none. */
export interface WriteSink {
  sites: CallSite[];
  unresolved: Unresolved[];
}

/** Is this receiver of a declared Map/cache-like type whose `.get` is never an HTTP read? Unknown is not benign. */
export function isBenignReceiver(src: Source, receiver: Node): boolean {
  const kinds = kindOf(src, receiver);
  return !!kinds && kinds.length > 0 && kinds.every((k) => BENIGN_RECEIVER_TYPES.has(k.name));
}

export function scanFile(file: string, sites: CallSite[], unresolved: Unresolved[], writes?: WriteSink): void {
  const src = load(file);
  const rel = relPosix(ROOT, file);
  const exempt = exemptRanges(src);
  const isExempt = (node: Node) => exempt.some((r) => node.start >= r.start && node.end <= r.end);
  const line = (node: Node) => lineOf(src, node.start);
  const flag = (node: Node, reason: string) => unresolved.push({ file: rel, line: line(node), reason });
  const site = (kind: CallKind, node: Node, path: string): CallSite => ({ kind, file: rel, line: line(node), path, pos: node.start });
  const pathOf = (arg: Node | undefined) => (arg ? constString(src, arg) : null);

  /** `fetchAllPages`, `paging.fetchAllPages`, or an import alias of it. */
  const isPager = (expr: Node) => {
    const node = unwrap(expr);
    if (node.type === "MemberExpression") return !node.computed && node.property.name === "fetchAllPages";
    if (node.type !== "Identifier") return false;
    if (node.name === "fetchAllPages") return true;
    const binding = lookup(src, node.name, node);
    const spec = binding?.kind === "import" ? binding.decl : null;
    return spec?.type === "ImportSpecifier" && (spec.imported.name ?? spec.imported.value) === "fetchAllPages";
  };

  const handled = new Set<Node>(); // callees, so the value-reference rules do not re-flag them

  walk(src.program, (node) => {
    if (node.type === "CallExpression") {
      const callee = unwrap(node.callee);
      const member = memberOf(node.callee);
      const args = node.arguments;
      if (isPager(node.callee)) {
        handled.add(callee);
        const path = args.length < 2 ? null : pathOf(args[1]);
        if (args.length < 2) flag(callee, "fetchAllPages call with no path argument");
        else if (path === null || !path.startsWith("/")) flag(callee, "fetchAllPages path is not a string literal starting with '/'");
        else sites.push(site("fetchAllPages", callee, path));
      } else if (callee.type === "Identifier" && (callee.name === "fetch" || callee.name === "axios")) {
        // The global fetch (scripts) and a bare axios(config): read the URL like a .get path.
        handled.add(callee);
        const url = callee.name === "fetch" ? pathOf(args[0]) : null;
        if (url === null) flag(callee, `${callee.name}() with a URL the scanner cannot resolve to a literal`);
        else {
          // A Mindbody URL or a '/…' path; any other host is not a Mindbody read. The public spec document is not a site read.
          const path = /^(?:https?:\/\/[^/]*mindbodyonline\.com(?:\/public\/v\d+)?)?(\/[^?#]*)/.exec(url)?.[1];
          if (path && normalisePath(path) !== "/swagger/doc") sites.push(site("get", callee, path));
        }
      } else if (member && HTTP_METHODS.has(member.name)) {
        handled.add(member.node);
        if (!isExempt(node) && !isBenignReceiver(src, member.receiver)) {
          const path = member.name === "get" ? pathOf(args[0]) : null;
          if (path !== null && path.startsWith("/")) sites.push(site("get", member.at, path));
          else flag(member.at, `.${member.name}() on a receiver that is not a Map or cache, with no literal '/…' path the scanner can check`);
        }
      } else if (writes && member && member.name === "post" && !isExempt(node) && !isBenignReceiver(src, member.receiver)) {
        const path = pathOf(args[0]);
        if (path !== null && path.startsWith("/")) writes.sites.push(site("post", member.at, path));
        else writes.unresolved.push({ file: rel, line: line(member.at), reason: ".post() with no literal '/…' path" });
      }
    } else if (node.type === "Identifier" && !handled.has(node) && isPager(node)) {
      const parent = src.parent.get(node);
      const declaration = parent?.type === "FunctionDeclaration" && parent.id === node;
      const specifier = parent?.type === "ImportSpecifier" || parent?.type === "ExportSpecifier";
      if (!declaration && !specifier && parent?.type !== "MemberExpression") flag(node, "fetchAllPages used as a value, not called");
    } else if (node.type === "MemberExpression") {
      const member = memberOf(node);
      if (member && HTTP_METHODS.has(member.name) && !handled.has(node) && !isExempt(node) && !isBenignReceiver(src, member.receiver)) {
        flag(member.at, `.${member.name} taken as a value (alias, bind or call) escapes the scan`);
      }
    }
  });
}

export function scanFiles(files: string[]): { sites: CallSite[]; unresolved: Unresolved[] } {
  const sites: CallSite[] = [];
  const unresolved: Unresolved[] = [];
  for (const file of files) scanFile(file, sites, unresolved);
  return { sites, unresolved };
}
