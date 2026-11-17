/**
 * Syntax-only source index for the Gate 13 scanner and the spec coverage report.
 *
 * Parses TypeScript with oxc-parser (no TypeScript compiler API, so it is
 * independent of the installed `typescript` version) and answers the few
 * questions the scanner used to ask a type checker:
 *
 *   - which declaration an identifier refers to (lexical scopes, then relative
 *     imports and re-exports followed across files);
 *   - which string constant a path argument holds (a literal, or a `const`
 *     bound to one, possibly imported);
 *   - which named type a receiver has, read from what the code declares: a type
 *     annotation, `new X(…)`, a call to a function with a declared return type
 *     (Promise unwrapped), `a ?? b` / `a || b` / `c ? a : b`, `Promise.all`
 *     destructuring, `this` / `this.field`, a field of an annotated interface or
 *     type literal, and `url.searchParams` on a `URL`.
 *
 * Anything it cannot resolve is unknown (null). Callers treat unknown as "may be
 * a Mindbody client", so the gate stays fail-closed: a resolver gap shows up as a
 * rule 5 failure, never as a missed read.
 */
import { existsSync, readFileSync } from "fs";
import { dirname, resolve } from "path";
import { parseSync } from "oxc-parser";

/** An ESTree / TS-ESTree node from oxc-parser. */
export type Node = any;

/** Keys that hold type syntax only; walks that look for calls and references skip them. */
const TYPE_KEYS = new Set(["typeAnnotation", "returnType", "typeParameters", "typeArguments", "superTypeArguments", "implements"]);
/** Declarations that are types only. */
const TYPE_DECLS = new Set(["TSInterfaceDeclaration", "TSTypeAliasDeclaration", "TSDeclareFunction", "TSEnumDeclaration"]);
const FUNCTIONS = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]);
const BLOCK_SCOPES = new Set(["Program", "BlockStatement", "StaticBlock", "ForStatement", "ForInStatement", "ForOfStatement", "SwitchStatement"]);

export interface Binding {
  name: string;
  src: Source;
  /** The declaring node: VariableDeclarator, function or class declaration, import specifier, or the parameter. */
  decl: Node;
  /** The identifier that declares the name (it carries the annotation, if any). */
  id: Node;
  kind: "const" | "let" | "var" | "param" | "function" | "class" | "import" | "catch";
  /** Set when the name is element `index` of a top-level array pattern (`const [a, b] = …`). */
  index?: number;
  /** A parameter's default value. */
  initial?: Node;
}

export interface Source {
  file: string;
  text: string;
  program: Node;
  parent: Map<Node, Node>;
  lineStarts: number[];
  scopes: Map<Node, Map<string, Binding>>;
}

const sources = new Map<string, Source>();

/** Parse `file` once (cached by path). Throws on a syntax error: an unparsable file is never scanned silently. */
export function load(file: string): Source {
  const cached = sources.get(file);
  if (cached) return cached;
  const text = readFileSync(file, "utf-8");
  const result = parseSync(file, text, { sourceType: "module" });
  if (result.errors.length) throw new Error(`cannot parse ${file}: ${result.errors[0].message}`);
  const src: Source = { file, text, program: result.program, parent: new Map(), lineStarts: [0], scopes: new Map() };
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) src.lineStarts.push(i + 1);
  index(src);
  sources.set(file, src);
  return src;
}

/** The child nodes of `node`, in source order. */
export function children(node: Node, withTypes = false): Node[] {
  const out: Node[] = [];
  for (const key of Object.keys(node)) {
    if (key === "type" || (!withTypes && TYPE_KEYS.has(key))) continue;
    const value = node[key];
    if (Array.isArray(value)) {
      for (const item of value) if (item && typeof item.type === "string") out.push(item);
    } else if (value && typeof value === "object" && typeof value.type === "string") out.push(value);
  }
  return out.sort((a, b) => a.start - b.start);
}

/** Pre-order walk of the value syntax (type annotations and type-only declarations skipped). */
export function walk(node: Node, visit: (node: Node) => void): void {
  if (TYPE_DECLS.has(node.type)) return;
  visit(node);
  for (const child of children(node)) walk(child, visit);
}

export function lineOf(src: Source, offset: number): number {
  let lo = 0;
  let hi = src.lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (src.lineStarts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/** Strip parentheses, casts, `!` and `satisfies`, so `(client.get as any)` reads as `client.get`. */
export function unwrap(node: Node): Node {
  while (
    node &&
    ["ParenthesizedExpression", "TSAsExpression", "TSTypeAssertion", "TSNonNullExpression", "TSSatisfiesExpression", "ChainExpression"].includes(node.type)
  ) {
    node = node.expression;
  }
  return node;
}

/** The name of a non-computed `.name`, or a `['name']` string key; null otherwise. */
export function memberName(node: Node): string | null {
  if (node?.type !== "MemberExpression") return null;
  if (!node.computed && node.property.type === "Identifier") return node.property.name;
  if (node.computed && node.property.type === "Literal" && typeof node.property.value === "string") return node.property.value;
  return null;
}

// ── Scopes and bindings ───────────────────────────────────────────────────────

function declare(src: Source, scope: Node, binding: Binding): void {
  const names = src.scopes.get(scope) ?? src.scopes.set(scope, new Map()).get(scope)!;
  if (!names.has(binding.name)) names.set(binding.name, binding);
}

/** Every identifier a binding pattern declares, with its top-level array index when there is one. */
function patternIds(pattern: Node, out: Array<{ id: Node; index?: number }> = [], index?: number): typeof out {
  if (!pattern) return out;
  switch (pattern.type) {
    case "Identifier":
      out.push({ id: pattern, index });
      break;
    case "AssignmentPattern":
      patternIds(pattern.left, out, index);
      break;
    case "RestElement":
      patternIds(pattern.argument, out);
      break;
    case "ArrayPattern":
      pattern.elements.forEach((el: Node, i: number) => patternIds(el, out, index === undefined ? i : undefined));
      break;
    case "ObjectPattern":
      for (const p of pattern.properties) patternIds(p.type === "RestElement" ? p.argument : p.value, out);
      break;
    case "TSParameterProperty":
      patternIds(pattern.parameter, out, index);
      break;
  }
  return out;
}

function enclosing(src: Source, node: Node, test: (n: Node) => boolean): Node {
  let cur = src.parent.get(node);
  while (cur && !test(cur)) cur = src.parent.get(cur);
  return cur ?? src.program;
}

function index(src: Source): void {
  const visit = (node: Node, parent: Node | null) => {
    if (parent) src.parent.set(node, parent);
    switch (node.type) {
      case "VariableDeclaration": {
        const kind = node.kind === "var" ? "var" : node.kind === "let" ? "let" : "const";
        const scope = kind === "var" ? enclosing(src, node, (n) => FUNCTIONS.has(n.type)) : null;
        for (const d of node.declarations) {
          src.parent.set(d, node);
          const at = scope ?? enclosing(src, d, (n) => BLOCK_SCOPES.has(n.type) || FUNCTIONS.has(n.type));
          for (const { id, index } of patternIds(d.id)) declare(src, at, { name: id.name, src, decl: d, id, kind, index });
        }
        break;
      }
      case "FunctionDeclaration":
      case "ClassDeclaration":
        if (node.id) {
          const at = enclosing(src, node, (n) => BLOCK_SCOPES.has(n.type) || FUNCTIONS.has(n.type));
          declare(src, at, { name: node.id.name, src, decl: node, id: node.id, kind: node.type === "ClassDeclaration" ? "class" : "function" });
        }
        break;
      case "ImportDeclaration":
        for (const s of node.specifiers) declare(src, src.program, { name: s.local.name, src, decl: s, id: s.local, kind: "import" });
        break;
      case "CatchClause":
        for (const { id } of patternIds(node.param)) declare(src, node, { name: id.name, src, decl: node, id, kind: "catch" });
        break;
    }
    if (FUNCTIONS.has(node.type) || node.type === "TSDeclareFunction") {
      for (const param of node.params ?? []) {
        const initial = param.type === "AssignmentPattern" ? param.right : param.type === "TSParameterProperty" && param.parameter.type === "AssignmentPattern" ? param.parameter.right : undefined;
        for (const { id } of patternIds(param)) declare(src, node, { name: id.name, src, decl: param, id, kind: "param", initial });
      }
    }
    for (const child of children(node, true)) visit(child, node);
  };
  visit(src.program, null);
}

/** The binding `name` refers to at `at`: the innermost enclosing scope that declares it. */
export function lookup(src: Source, name: string, at: Node): Binding | null {
  for (let cur: Node = at; cur; cur = src.parent.get(cur)) {
    const hit = src.scopes.get(cur)?.get(name);
    if (hit) return hit;
  }
  return null;
}

// ── Modules ───────────────────────────────────────────────────────────────────

/** A relative import resolved to a .ts/.tsx file (the `.js` of nodenext imports maps to `.ts`); null for packages. */
export function resolveModule(from: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null;
  const base = resolve(dirname(from), spec);
  const stem = base.replace(/\.(?:js|jsx|ts|tsx|mjs|cjs)$/, "");
  for (const candidate of [`${stem}.ts`, `${stem}.tsx`, `${base}/index.ts`, `${stem}/index.ts`]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

type Exported = { binding: Binding } | { type: Node; src: Source } | { namespace: Source };

/** What module `src` exports as `name`, following `export { a as b }`, re-exports and `export *`. */
export function resolveExport(src: Source, name: string, seen = new Set<string>()): Exported | null {
  const key = `${src.file}#${name}`;
  if (seen.has(key)) return null;
  seen.add(key);
  const stars: string[] = [];
  for (const stmt of src.program.body) {
    if (stmt.type === "ExportNamedDeclaration") {
      const d = stmt.declaration;
      if (d) {
        if (d.type === "VariableDeclaration") {
          for (const decl of d.declarations) {
            for (const { id } of patternIds(decl.id)) if (id.name === name) return wrap(lookup(src, name, src.program));
          }
        } else if (d.id?.name === name) {
          if (d.type === "TSInterfaceDeclaration" || d.type === "TSTypeAliasDeclaration") return { type: d, src };
          return wrap(lookup(src, name, src.program));
        }
      }
      for (const s of stmt.specifiers ?? []) {
        const exported = s.exported.name ?? s.exported.value;
        if (exported !== name) continue;
        const local = s.local.name ?? s.local.value;
        if (stmt.source) {
          const target = resolveModule(src.file, stmt.source.value);
          return target ? resolveExport(load(target), local, seen) : null;
        }
        const binding = lookup(src, local, src.program);
        if (binding) return { binding };
        const type = typeDecl(src, local);
        return type ? { type, src } : null;
      }
    } else if (stmt.type === "ExportDefaultDeclaration" && name === "default") {
      const d = stmt.declaration;
      if (d.id) return wrap(lookup(src, d.id.name, src.program));
      return null;
    } else if (stmt.type === "ExportAllDeclaration") {
      if (stmt.exported) {
        if ((stmt.exported.name ?? stmt.exported.value) === name) {
          const target = resolveModule(src.file, stmt.source.value);
          return target ? { namespace: load(target) } : null;
        }
      } else stars.push(stmt.source.value);
    }
  }
  for (const spec of stars) {
    const target = resolveModule(src.file, spec);
    const hit = target ? resolveExport(load(target), name, seen) : null;
    if (hit) return hit;
  }
  return null;
}

const wrap = (binding: Binding | null): Exported | null => (binding ? { binding } : null);

/** Follow an import binding to what it imports; any other binding is returned as is. */
export function follow(binding: Binding | null, depth = 0): Exported | null {
  if (!binding) return null;
  if (binding.kind !== "import" || depth > 20) return { binding };
  const spec = binding.decl;
  const declaration = binding.src.parent.get(spec);
  const target = resolveModule(binding.src.file, declaration.source.value);
  if (!target) return null;
  const mod = load(target);
  if (spec.type === "ImportNamespaceSpecifier") return { namespace: mod };
  const imported = spec.type === "ImportDefaultSpecifier" ? "default" : (spec.imported.name ?? spec.imported.value);
  const hit = resolveExport(mod, imported);
  return hit && "binding" in hit ? follow(hit.binding, depth + 1) : hit;
}

/** A module-level interface, type alias or class named `name` in `src`, or imported into it. */
function typeDecl(src: Source, name: string): Node | null {
  for (const stmt of src.program.body) {
    const d = stmt.type === "ExportNamedDeclaration" || stmt.type === "ExportDefaultDeclaration" ? stmt.declaration : stmt;
    if (d && ["TSInterfaceDeclaration", "TSTypeAliasDeclaration", "ClassDeclaration"].includes(d.type) && d.id?.name === name) return d;
  }
  return null;
}

/** [declaration, its source] for a named type visible in `src`, following imports. */
function findType(src: Source, name: string): [Node, Source] | null {
  const local = typeDecl(src, name);
  if (local) return [local, src];
  const binding = lookup(src, name, src.program);
  if (binding?.kind !== "import") return null;
  const hit = follow(binding);
  if (!hit) return null;
  if ("type" in hit) return [hit.type, hit.src];
  if ("binding" in hit && hit.binding.kind === "class") return [hit.binding.decl, hit.binding.src];
  return null;
}

// ── String constants ──────────────────────────────────────────────────────────

/** The string an expression statically holds: a literal, a substitution-free template, or a `const` bound to one. */
export function constString(src: Source, expr: Node, depth = 0): string | null {
  const node = unwrap(expr);
  if (!node || depth > 20) return null;
  if (node.type === "Literal" && typeof node.value === "string") return node.value;
  if (node.type === "TemplateLiteral" && node.expressions.length === 0) return node.quasis[0].value.cooked;
  if (node.type !== "Identifier") return null;
  const hit = follow(lookup(src, node.name, node));
  if (!hit || !("binding" in hit)) return null;
  const b = hit.binding;
  const literalType = b.id.typeAnnotation?.typeAnnotation;
  if (literalType?.type === "TSLiteralType" && typeof literalType.literal.value === "string") return literalType.literal.value;
  if (b.kind !== "const" || b.index !== undefined || b.decl.id !== b.id || !b.decl.init) return null;
  return constString(b.src, b.decl.init, depth + 1);
}

// ── Receiver types ────────────────────────────────────────────────────────────

/** A named type, with its declaration when the code declares it (for member lookups). */
export interface Kind {
  name: string;
  decl?: Node;
  src?: Source;
}

const union = (parts: Array<Kind[] | null>): Kind[] | null => (parts.some((p) => p === null) ? null : parts.flat() as Kind[]);

/** The named types a type annotation denotes; null if any part is not a named or declared type. */
export function typeKinds(src: Source, type: Node, unwrapPromise = false, depth = 0): Kind[] | null {
  if (!type || depth > 20) return null;
  switch (type.type) {
    case "TSTypeAnnotation":
      return typeKinds(src, type.typeAnnotation, unwrapPromise, depth + 1);
    case "TSParenthesizedType":
      return typeKinds(src, type.typeAnnotation, unwrapPromise, depth + 1);
    case "TSUnionType":
      return union(
        type.types
          .filter((t: Node) => t.type !== "TSUndefinedKeyword" && t.type !== "TSNullKeyword")
          .map((t: Node) => typeKinds(src, t, unwrapPromise, depth + 1))
      );
    case "TSTypeLiteral":
      return [{ name: "", decl: type, src }];
    case "TSTypeReference": {
      const name = type.typeName.type === "Identifier" ? type.typeName.name : type.typeName.right?.name;
      if (!name) return null;
      if (name === "Promise" && unwrapPromise) return typeKinds(src, type.typeArguments?.params?.[0], false, depth + 1);
      const found = findType(src, name);
      if (found?.[0].type === "TSTypeAliasDeclaration") return typeKinds(found[1], found[0].typeAnnotation, unwrapPromise, depth + 1);
      return [{ name, decl: found?.[0], src: found?.[1] }];
    }
    default:
      return null;
  }
}

/** The declared type of member `name` of a declared type (interface, type literal or class); null if unknown. */
function memberKinds(kind: Kind, name: string, depth: number): Kind[] | null {
  const { decl, src } = kind;
  if (!decl || !src) return kind.name === "URL" && name === "searchParams" ? [{ name: "URLSearchParams" }] : null;
  const members = decl.type === "TSInterfaceDeclaration" ? decl.body.body : decl.type === "TSTypeLiteral" ? decl.members : decl.body?.body;
  for (const m of members ?? []) {
    if (m.type === "TSPropertySignature" && !m.computed && m.key?.name === name) return typeKinds(src, m.typeAnnotation, false, depth + 1);
    if (m.type === "PropertyDefinition" && !m.computed && m.key?.name === name) {
      return m.typeAnnotation ? typeKinds(src, m.typeAnnotation, false, depth + 1) : m.value ? kindOf(src, m.value, depth + 1) : null;
    }
    if (m.type === "MethodDefinition" && m.kind === "constructor") {
      for (const p of m.value.params) {
        if (p.type !== "TSParameterProperty") continue;
        const id = p.parameter.type === "AssignmentPattern" ? p.parameter.left : p.parameter;
        if (id.name === name) return typeKinds(src, id.typeAnnotation, false, depth + 1);
      }
    }
  }
  return null;
}

/** The declared return type of the function a callee names (Promise unwrapped); null if not declared. */
function returnKinds(src: Source, callee: Node, depth: number): Kind[] | null {
  if (callee.type !== "Identifier") return null;
  const hit = follow(lookup(src, callee.name, callee));
  if (!hit || !("binding" in hit)) return null;
  const { decl, src: at } = hit.binding;
  const fn = decl.type === "FunctionDeclaration" ? decl : decl.type === "VariableDeclarator" ? unwrap(decl.init) : null;
  if (!fn || !FUNCTIONS.has(fn.type) || !fn.returnType) return null;
  return typeKinds(at, fn.returnType, true, depth + 1);
}

function bindingKinds(binding: Binding, depth: number): Kind[] | null {
  const hit = follow(binding);
  if (!hit) return null;
  if ("namespace" in hit || "type" in hit) return null;
  const b = hit.binding;
  const annotated = b.id.typeAnnotation;
  if (annotated) return typeKinds(b.src, annotated, false, depth + 1);
  switch (b.kind) {
    case "param":
      return b.initial ? kindOf(b.src, b.initial, depth + 1) : null;
    case "class":
      return [{ name: b.name, decl: b.decl, src: b.src }];
    case "const":
    case "let":
    case "var": {
      if (b.decl.id === b.id) return b.decl.init ? kindOf(b.src, b.decl.init, depth + 1) : null;
      // `const [a, b] = await Promise.all([x, y])`: element i has the type of x / y.
      const init = unwrap(b.decl.init);
      const call = init?.type === "AwaitExpression" ? unwrap(init.argument) : null;
      const isAll = call?.type === "CallExpression" && memberName(unwrap(call.callee)) === "all" && unwrap(call.callee).object?.name === "Promise";
      const list = isAll ? unwrap(call.arguments[0]) : null;
      if (b.index === undefined || list?.type !== "ArrayExpression") return null;
      const element = list.elements[b.index];
      return element ? kindOf(b.src, element, depth + 1) : null;
    }
    default:
      return null;
  }
}

/** The named types of an expression's value, read from declarations; null when they cannot be known. */
export function kindOf(src: Source, expr: Node, depth = 0): Kind[] | null {
  if (!expr || depth > 30) return null;
  switch (expr.type) {
    case "ParenthesizedExpression":
    case "TSNonNullExpression":
    case "TSSatisfiesExpression":
    case "ChainExpression":
      return kindOf(src, expr.expression, depth + 1);
    case "TSAsExpression":
    case "TSTypeAssertion": {
      const t = expr.typeAnnotation;
      const asConst = t?.type === "TSTypeReference" && t.typeName?.name === "const";
      return asConst ? kindOf(src, expr.expression, depth + 1) : typeKinds(src, t, false, depth + 1);
    }
    case "AwaitExpression":
      return kindOf(src, expr.argument, depth + 1);
    case "NewExpression": {
      const callee = unwrap(expr.callee);
      if (callee.type !== "Identifier") return null;
      const found = findType(src, callee.name);
      return [{ name: callee.name, decl: found?.[0], src: found?.[1] }];
    }
    case "Identifier": {
      const binding = lookup(src, expr.name, expr);
      return binding ? bindingKinds(binding, depth + 1) : null;
    }
    case "ThisExpression": {
      const cls = enclosing(src, expr, (n) => n.type === "ClassDeclaration" || n.type === "ClassExpression");
      return cls === src.program ? null : [{ name: cls.id?.name ?? "", decl: cls, src }];
    }
    case "LogicalExpression":
      return expr.operator === "&&" ? null : union([kindOf(src, expr.left, depth + 1), kindOf(src, expr.right, depth + 1)]);
    case "ConditionalExpression":
      return union([kindOf(src, expr.consequent, depth + 1), kindOf(src, expr.alternate, depth + 1)]);
    case "CallExpression": {
      const callee = unwrap(expr.callee);
      // Map#set returns the map: `m.set(k, v).get(k)`.
      if (memberName(callee) === "set") {
        const target = kindOf(src, callee.object, depth + 1);
        if (target?.every((k) => ["Map", "WeakMap"].includes(k.name))) return target;
      }
      return returnKinds(src, callee, depth);
    }
    case "MemberExpression": {
      const name = memberName(expr);
      const owner = name ? kindOf(src, expr.object, depth + 1) : null;
      return owner ? union(owner.map((k) => memberKinds(k, name!, depth + 1))) : null;
    }
    default:
      return null;
  }
}

// ── References (for the coverage call graph) ──────────────────────────────────

/**
 * The declaration an identifier refers to, through imports: a binding, a class
 * member reached as `this.x` or `obj.x` on a declared class, or a namespace member.
 * Null for declaration names, object keys, unresolvable and global names.
 */
export function referenceOf(src: Source, id: Node): { decl: Node; src: Source } | null {
  const parent = src.parent.get(id);
  if (parent?.type === "MemberExpression" && parent.property === id && !parent.computed) {
    const object = unwrap(parent.object);
    if (object.type === "Identifier") {
      const hit = follow(lookup(src, object.name, object));
      if (hit && "namespace" in hit) {
        const exported = resolveExport(hit.namespace, id.name);
        return exported && "binding" in exported ? declOf(follow(exported.binding)) : null;
      }
    }
    for (const k of kindOf(src, object) ?? []) {
      if (k.decl?.type !== "ClassDeclaration" && k.decl?.type !== "ClassExpression") continue;
      const member = k.decl.body.body.find((m: Node) => !m.computed && m.key?.name === id.name && (m.type === "MethodDefinition" || m.type === "PropertyDefinition"));
      if (member) return { decl: member, src: k.src! };
    }
    return null;
  }
  if (parent && (parent.type === "Property" || parent.type === "MethodDefinition" || parent.type === "PropertyDefinition") && parent.key === id && !parent.computed) {
    return null;
  }
  if (parent?.type === "Property" && parent.shorthand) return null;
  // `import { a as b }` / `export { a as b }`: both names stand for the local binding.
  if (parent?.type === "ImportSpecifier") return declOf(follow(lookup(src, parent.local.name, parent)));
  if (parent?.type === "ExportSpecifier") {
    const decl = src.parent.get(parent);
    if (decl?.source) return null;
    return declOf(follow(lookup(src, parent.local.name ?? parent.local.value, parent)));
  }
  return declOf(follow(lookup(src, id.name, id)));
}

function declOf(hit: Exported | null): { decl: Node; src: Source } | null {
  return hit && "binding" in hit ? { decl: hit.binding.decl, src: hit.binding.src } : null;
}
