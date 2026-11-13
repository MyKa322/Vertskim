import type { Node, Query } from "@vscode/tree-sitter-wasm";
import {
  SELF_QUALIFIER,
  TYPED_PREFIX,
  UNKNOWN_PREFIX,
  type Extraction,
  type FieldHint,
  type GraphNode,
  type ImportDecl,
  type RawRef,
  type RefKind,
} from "../types.js";
import { getParser, getRuntime, loadLanguage } from "./runtime.js";
import { MIN_NESTED_LINES, type LanguageSpec, type RawDef, type SymbolInfo } from "./spec.js";

const queries = new Map<string, Query>();

async function getQuery(spec: LanguageSpec): Promise<Query> {
  let query = queries.get(spec.grammar);
  if (!query) {
    const [rt, language] = await Promise.all([getRuntime(), loadLanguage(spec.grammar)]);
    query = new rt.Query(language, spec.query);
    queries.set(spec.grammar, query);
  }
  return query;
}

/** When two patterns match the same node, the more specific kind wins. */
const DEF_PRIORITY: Record<string, number> = { variable: 0 };

interface RefCapture {
  kind: string;
  node: Node;
  nameNode: Node;
  qualifier: Node | null;
  /** Name of the symbol the reference belongs to, when it is written outside that symbol. */
  subject: string | null;
}

/** A variable, parameter or field whose type is written down or can be inferred. */
interface TypeHint {
  type: string;
  index: number;
}

/** How much a hint is trusted when one declaration has several: a written type beats `new X()`, which beats a call. */
const HINT_RANK = { vartype: 3, newtype: 2, varcall: 1, varvalue: 1 } as const;

/** Node types whose first named child is the expression they start from: `a.b`, `a()`, `a[0]`, `a!`. */
const CHAIN_TYPES = new Set([
  // TypeScript and JavaScript, Python
  "member_expression",
  "call_expression",
  "subscript_expression",
  "non_null_expression",
  "parenthesized_expression",
  "await_expression",
  "attribute",
  "call",
  "subscript",
  // Go, Rust, C and C++
  "selector_expression",
  "field_expression",
  "index_expression",
  "try_expression",
  // Java, C#
  "field_access",
  "method_invocation",
  "array_access",
  "member_access_expression",
  "invocation_expression",
  "element_access_expression",
  // PHP, Ruby
  "member_call_expression",
  "nullsafe_member_call_expression",
  "nullsafe_member_access_expression",
  "element_reference",
]);

/** Fields naming the member in a member access or call, across the grammars. */
const MEMBER_FIELDS = ["property", "attribute", "field", "name", "method"];
/** Fields naming what a member is accessed on. */
const OBJECT_FIELDS = ["object", "operand", "value", "argument", "expression", "receiver"];
/** Nodes a receiver can start from: a plain name, or a PHP `$variable`. */
const ROOT_TYPES = new Set(["identifier", "variable_name"]);

function firstField(node: Node, fields: string[]): Node | null {
  for (const field of fields) {
    const child = node.childForFieldName(field);
    if (child) return child;
  }
  return null;
}

/**
 * What a call is made on and the member it calls, in any grammar: `a.b()`, Go's
 * `a.B()`, Java's `a.b()`, PHP's `$a->b()`, Ruby's `a.b`. `receiver` is null for a bare call.
 */
function callParts(node: Node): { receiver: Node | null; member: string } | null {
  // A call whose callee is a separate node: JS, Python, Go, Rust, C, C++, C#.
  const callee = node.childForFieldName("function");
  if (callee) {
    if (ROOT_TYPES.has(callee.type) || callee.type === "name") return { receiver: null, member: callee.text };
    const member = firstField(callee, MEMBER_FIELDS);
    const object = firstField(callee, OBJECT_FIELDS);
    return member && object ? { receiver: object, member: member.text } : null;
  }
  // A call node that names the member itself: Java, PHP, Ruby.
  const member = firstField(node, ["name", "method"]);
  if (!member) return null;
  return { receiver: firstField(node, OBJECT_FIELDS), member: member.text };
}

/**
 * Where a receiver expression starts: `z` in `z.number().int()`, `this.db` in
 * `this.db.prepare(sql).all()`. Null when it starts with something else.
 */
function receiverRoot(node: Node, selfNames: Set<string>): string | null {
  const path: Node[] = [];
  let current: Node | null = node;
  for (let depth = 0; current && depth < 16 && CHAIN_TYPES.has(current.type); depth++) {
    path.push(current);
    current = current.namedChild(0);
  }
  if (!current) return null;
  const text = current.text;
  const isSelf = current.type === "this" || selfNames.has(text);
  if (!isSelf) return ROOT_TYPES.has(current.type) && /^[\p{L}\p{N}_$]+$/u.test(text) ? text : null;
  // `this.field`: the field is the member accessed on it.
  const parent = path[path.length - 1];
  for (const field of MEMBER_FIELDS) {
    const member = parent?.childForFieldName(field);
    if (member && /^[\p{L}\p{N}_$]+$/u.test(member.text)) return `${text}.${member.text}`;
  }
  return null;
}

/** The function a variable's value comes from, as `()name` or `()receiver name`; null when it is not that simple. */
function calleeHint(node: Node): string | null {
  if (node.type === "identifier") return `()${node.text}`;
  const member = firstField(node, MEMBER_FIELDS);
  const object = firstField(node, OBJECT_FIELDS);
  if (!member || !object) return null;
  const receiver = qualifierText(object);
  if (!receiver || receiver === "?" || receiver === "super") return null;
  return `()${receiver} ${member.text}`;
}

const TYPE_KINDS = new Set(["class", "interface", "type"]);

/** 1-based line of the first place the parser could not make sense of, or null for a clean parse. */
function firstErrorLine(root: Node): number | null {
  if (!root.hasError) return null;
  // Follow the first child that carries the error down to where it is. A missing token is not
  // always marked as such, so the walk does not rely on that: it stops where no child has the error.
  let node = root;
  for (let depth = 0; depth < 500 && !node.isError && !node.isMissing; depth++) {
    let next: Node | null = null;
    for (let i = 0; i < node.childCount && !next; i++) {
      const child = node.child(i);
      if (child?.hasError || child?.isMissing) next = child;
    }
    if (!next) break;
    node = next;
  }
  return node.startPosition.row + 1;
}

/** How many places a parse went wrong: subtrees that carry an error but none of whose children do. */
function errorCount(root: Node): number {
  let count = 0;
  const stack: Node[] = [root];
  while (stack.length > 0 && count < 10_000) {
    const node = stack.pop()!;
    if (!node.hasError && !node.isMissing) continue;
    let childHasError = false;
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child?.hasError || child?.isMissing) {
        childHasError = true;
        stack.push(child);
      }
    }
    if (!childHasError || node.isError) count++;
  }
  return count;
}

/** Reduce a receiver expression to something the resolver can look up, or `?`. */
function qualifierText(node: Node | null): string | null {
  if (!node) return null;
  // Path separators and pointer access of other languages (`a::b`, `a->b`) are stored the same way as `a.b`.
  const text = node.text.replace(/\s*(?:::|->)\s*/g, ".");
  if (text.length <= 80 && /^[\p{L}\p{N}_$.]+$/u.test(text)) return text;
  if (/^super\b/.test(text)) return "super";
  return "?";
}

const REF_KIND: Record<string, RefKind> = {
  call: "calls",
  new: "new",
  extends: "extends",
  implements: "implements",
  type: "type",
  ident: "references",
};

/**
 * Extract symbols, references and imports from one source file using the
 * language's tree-sitter query. Language-agnostic: everything specific comes
 * from the {@link LanguageSpec}.
 */
export async function extractCode(spec: LanguageSpec, path: string, source: string): Promise<Extraction> {
  const [parser, query] = await Promise.all([getParser(spec.grammar), getQuery(spec)]);
  let tree = parser.parse(source);
  if (!tree) return { nodes: [], refs: [], imports: [] };
  if (tree.rootNode.hasError && spec.reparse) {
    // Positions are unchanged in the retried text, so signatures can still be cut from `source`.
    const retried = spec.reparse(source, tree.rootNode);
    const second = retried !== null && retried !== source ? parser.parse(retried) : null;
    if (second && errorCount(second.rootNode) < errorCount(tree.rootNode)) {
      tree.delete();
      tree = second;
    } else {
      second?.delete();
    }
  }
  const ignored = spec.ignoredNames;

  try {
    const rawDefs = new Map<number, RawDef>();
    const refCaptures: RefCapture[] = [];
    const scanned: Node[] = [];
    const importNodes = new Map<number, Node>();
    const exportNames: { name: string; isDefault: boolean }[] = [];
    const typeParams = new Set<string>();
    const rawHints: { name: string; type: string; index: number; rank: number; field: boolean }[] = [];

    for (const match of query.matches(tree.rootNode)) {
      let nameNode: Node | null = null;
      let qualifier: Node | null = null;
      let subject: string | null = null;
      let varNode: Node | null = null;
      let varType: Node | null = null;
      let hintRank = 0;
      let fieldHint = false;
      let aliasHint = false;
      let def: { kind: string; node: Node } | null = null;
      let ref: { kind: string; node: Node } | null = null;
      let exp: string | null = null;
      for (const capture of match.captures) {
        const cn = capture.name;
        if (cn === "name") nameNode = capture.node;
        else if (cn === "qualifier") qualifier = capture.node;
        else if (cn.startsWith("def.")) def = { kind: cn.slice(4), node: capture.node };
        else if (cn.startsWith("ref.")) ref = { kind: cn.slice(4), node: capture.node };
        else if (cn === "import") importNodes.set(capture.node.id, capture.node);
        else if (cn === "scan") scanned.push(capture.node);
        else if (cn.startsWith("export.")) exp = cn.slice(7);
        else if (cn === "typeparam") typeParams.add(capture.node.text);
        else if (cn === "subject") subject = capture.node.text;
        else if (cn === "var") varNode = capture.node;
        else if (cn === "fieldvar") {
          varNode = capture.node;
          fieldHint = true;
        } else if (cn === "vartype" || cn === "newtype" || cn === "varcall" || cn === "varvalue") {
          varType = capture.node;
          hintRank = HINT_RANK[cn];
          aliasHint = cn === "varvalue";
        }
      }
      if (varNode && varType) {
        let type: string | null;
        if (aliasHint) {
          const text = qualifierText(varType);
          type = text && text !== "?" && text !== "super" ? `=${text}` : null;
        } else if (hintRank === HINT_RANK.varcall) type = calleeHint(varType);
        else if (hintRank === HINT_RANK.newtype) type = qualifierText(varType);
        else type = spec.hintType ? spec.hintType(varType) : varType.text;
        if (type && type !== "?") {
          rawHints.push({ name: varNode.text, type, index: varNode.startIndex, rank: hintRank, field: fieldHint });
        }
      }
      if (def && nameNode) {
        const previous = rawDefs.get(def.node.id);
        if (!previous || (DEF_PRIORITY[def.kind] ?? 1) > (DEF_PRIORITY[previous.kind] ?? 1)) {
          rawDefs.set(def.node.id, { node: def.node, nameNode, kind: def.kind, name: nameNode.text });
        }
      } else if (ref) {
        refCaptures.push({ kind: ref.kind, node: ref.node, nameNode: nameNode ?? ref.node, qualifier, subject });
      } else if (exp && nameNode) {
        exportNames.push({ name: nameNode.text, isDefault: exp === "default" });
      }
    }

    // ---- definitions, outermost first so parents are settled before children
    const sorted = [...rawDefs.values()].sort(
      (a, b) => a.node.startIndex - b.node.startIndex || b.node.endIndex - a.node.endIndex,
    );
    const kept = new Map<number, SymbolInfo>();
    const skipped = new Set<number>();
    const claimed = new Set<number>();
    const usedIds = new Set<string>();
    const nodes: GraphNode[] = [];
    const nodeById = new Map<string, GraphNode>();
    const symbols: SymbolInfo[] = [];
    const ownedNodes: { node: GraphNode; owner: string }[] = [];

    for (const def of sorted) {
      claimed.add(def.nameNode.id);
      let parent: SymbolInfo | null = null;
      let blocked = false;
      let nested = false;
      for (let a = def.node.parent; a; a = a.parent) {
        const enclosing = kept.get(a.id);
        if (enclosing) {
          parent = enclosing;
          break;
        }
        if (skipped.has(a.id)) {
          blocked = true;
          break;
        }
        if (spec.scopeBreakers.has(a.type)) {
          if (!spec.nestedDefs) {
            blocked = true;
            break;
          }
          nested = true;
        }
      }
      // Inside a body, a definition counts only when a named symbol owns it and it is not a one-liner.
      if (
        nested &&
        (!parent || spec.outer(def).endPosition.row - spec.outer(def).startPosition.row + 1 < MIN_NESTED_LINES)
      ) {
        blocked = true;
      }
      const decision = blocked ? null : spec.classify(def, parent, nested);
      if (!decision) {
        skipped.add(def.node.id);
        continue;
      }
      const name = decision.name ?? def.name;
      const owner = decision.owner ?? null;
      let qname = owner ? `${owner}.${name}` : parent ? `${parent.qname}.${name}` : name;
      if (usedIds.has(`${path}#${qname}`)) {
        let n = 2;
        while (usedIds.has(`${path}#${qname}~${n}`)) n++;
        qname = `${qname}~${n}`;
      }
      const id = `${path}#${qname}`;
      usedIds.add(id);

      const outer = spec.outer(def);
      const doc = spec.doc(def, outer, source);
      const exported = spec.exported(def, outer, parent);
      const symbol: SymbolInfo = {
        id,
        qname,
        name,
        kind: decision.kind,
        exported,
        parent,
        owner,
        selfName: decision.selfName ?? null,
        start: outer.startIndex,
        end: outer.endIndex,
      };
      kept.set(def.node.id, symbol);
      symbols.push(symbol);
      const node: GraphNode = {
        id,
        kind: decision.kind,
        subkind: decision.subkind ?? null,
        name,
        path,
        parent: parent ? parent.id : path,
        startLine: doc.startLine ?? outer.startPosition.row + 1,
        endLine: outer.endPosition.row + 1,
        language: spec.id,
        signature: spec.signature(def, outer, source),
        doc: doc.text,
        exported,
      };
      nodes.push(node);
      nodeById.set(id, node);
      if (owner) ownedNodes.push({ node, owner });
    }
    // A method written outside its type hangs off that type when both are in this file.
    for (const { node, owner } of ownedNodes) {
      const ownerId = `${path}#${owner}`;
      if (nodeById.has(ownerId)) node.parent = ownerId;
    }

    // ---- names exported separately from their definition: `export { a }`, `export default a`
    for (const exp of exportNames) {
      const symbol = symbols.find((s) => !s.parent && s.name === exp.name);
      if (!symbol) continue;
      const level = exp.isDefault ? 2 : Math.max(symbol.exported, 1);
      symbol.exported = level as SymbolInfo["exported"];
      nodeById.get(symbol.id)!.exported = symbol.exported;
    }

    // ---- imports
    const imports: ImportDecl[] = [];
    const importRanges: [number, number][] = [];
    for (const node of importNodes.values()) {
      importRanges.push([node.startIndex, node.endIndex]);
      imports.push(...spec.parseImport(node));
    }
    const insideImport = (index: number) => importRanges.some(([s, e]) => index >= s && index < e);

    // ---- references
    symbols.sort((a, b) => a.start - b.start || b.end - a.end);
    const starts = symbols.map((s) => s.start);
    /** Innermost accepted definition containing a source offset. */
    const enclosingSymbol = (index: number): SymbolInfo | null => {
      let lo = 0;
      let hi = starts.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (starts[mid]! <= index) lo = mid + 1;
        else hi = mid;
      }
      let candidate: SymbolInfo | null = lo > 0 ? symbols[lo - 1]! : null;
      while (candidate && candidate.end <= index) candidate = candidate.parent;
      return candidate;
    };

    // ---- declared types of variables, parameters and fields, by the symbol they are written in
    const hints = new Map<string, Map<string, TypeHint[]>>();
    const typeScopes = new Set(symbols.filter((s) => TYPE_KINDS.has(s.kind)).map((s) => s.id));
    const hintScopeIsType = (scope: string) => typeScopes.has(scope);
    // One declaration can be matched by several patterns: keep the most trusted, and nothing when those disagree.
    const chosen = new Map<string, { scope: string; name: string; index: number; rank: number; types: Set<string> }>();
    for (const hint of rawHints) {
      if (ignored?.has(hint.type) || typeParams.has(hint.type)) continue;
      let owner = enclosingSymbol(hint.index);
      // A variable is not a scope: `let x: T` at the top of a file is visible to the whole file.
      while (owner && owner.kind === "variable") owner = owner.parent;
      if (hint.field) while (owner && !TYPE_KINDS.has(owner.kind)) owner = owner.parent;
      if (hint.field && !owner) continue;
      const scope = owner?.id ?? path;
      const key = `${scope}\u0000${hint.name}\u0000${hint.index}`;
      const existing = chosen.get(key);
      if (!existing || existing.rank < hint.rank) {
        chosen.set(key, { scope, name: hint.name, index: hint.index, rank: hint.rank, types: new Set([hint.type]) });
      } else if (existing.rank === hint.rank) existing.types.add(hint.type);
    }
    for (const hint of chosen.values()) {
      if (hint.types.size !== 1) continue;
      const type = [...hint.types][0]!;
      let byName = hints.get(hint.scope);
      if (!byName) {
        byName = new Map();
        hints.set(hint.scope, byName);
      }
      const list = byName.get(hint.name);
      if (list) list.push({ type, index: hint.index });
      else byName.set(hint.name, [{ type, index: hint.index }]);
    }
    for (const byName of hints.values()) for (const list of byName.values()) list.sort((a, b) => a.index - b.index);

    /**
     * Replace a receiver the file says enough about: the method's own receiver
     * variable, or a variable or field whose type is written down.
     */
    /** The hint for a name in the scopes around `at`: variables and parameters, or fields only. */
    const lookupHint = (name: string, at: number, fieldOnly: boolean): TypeHint | null => {
      if (hints.size === 0) return null;
      const scopes: string[] = [];
      for (let s = enclosingSymbol(at); s; s = s.parent) {
        if (!fieldOnly || TYPE_KINDS.has(s.kind)) scopes.push(s.id);
        if (s.owner) scopes.push(`${path}#${s.owner}`);
      }
      if (!fieldOnly) scopes.push(path);
      for (const scope of scopes) {
        const list = hints.get(scope)?.get(name);
        if (!list) continue;
        let best = list[0]!;
        for (const hint of list) if (hint.index <= at) best = hint;
        return best;
      }
      return null;
    };
    const encodeHint = (hint: TypeHint, depth: number): string | null => {
      if (hint.type.startsWith("=")) {
        // The same value as another expression: its type, if that is known.
        if (depth >= 3) return null;
        const typed = typedQualifier(hint.type.slice(1), hint.index, depth + 1);
        return typed.startsWith(TYPED_PREFIX) ? typed : null;
      }
      if (!hint.type.startsWith("()")) return TYPED_PREFIX + hint.type;
      // A value returned by a call: the call's own receiver is typed in turn, so the resolver can find the callee.
      const space = hint.type.lastIndexOf(" ");
      if (space < 0) return TYPED_PREFIX + hint.type;
      const receiver = hint.type.slice(2, space);
      const typedReceiver = depth < 3 ? typedQualifier(receiver, hint.index, depth + 1) : receiver;
      return `${TYPED_PREFIX}()${typedReceiver}${hint.type.slice(space)}`;
    };
    /**
     * Replace a receiver the file says enough about with what is known of its type:
     * `:Store` for a variable typed Store, `:.>:Store db` for its field `db`, `@self`
     * for the method's own object. Unchanged when nothing is known.
     */
    const typedQualifier = (qualifier: string, at: number, depth = 0): string => {
      const enclosing = enclosingSymbol(at);
      const isSelf = (name: string) => {
        if (spec.selfNames.has(name)) return true;
        for (let s = enclosing; s; s = s.parent) if (s.selfName === name) return true;
        return false;
      };
      const segments = qualifier.split(".");
      const first = segments[0]!;
      let expr: string;
      let next: number;
      if (isSelf(first)) {
        if (segments.length === 1) return spec.selfNames.has(first) ? qualifier : SELF_QUALIFIER;
        const field = lookupHint(segments[1]!, at, true);
        expr = (field && encodeHint(field, depth)) || `${TYPED_PREFIX}.>${SELF_QUALIFIER} ${segments[1]}`;
        next = 2;
      } else {
        const hint = lookupHint(first, at, false);
        const typed = hint ? encodeHint(hint, depth) : null;
        if (!typed) return qualifier;
        expr = typed;
        next = 1;
      }
      for (let i = next; i < segments.length; i++) expr = `${TYPED_PREFIX}.>${expr} ${segments[i]}`;
      return expr;
    };
    /** A receiver that is itself a call, typed link by link: `a.b().c()` becomes the result of `c` on the result of `b`. */
    const chainQualifier = (node: Node, at: number, depth = 0): string | null => {
      if (depth > 5) return null;
      switch (node.type) {
        case "parenthesized_expression":
        case "non_null_expression":
        case "await_expression": {
          const inner = node.namedChild(0);
          return inner ? chainQualifier(inner, at, depth + 1) : null;
        }
        case "object_creation_expression":
        case "new_expression": {
          // `new GsonBuilder().create()`, `new TypeAdapter<T>() { ... }.nullSafe()`: a call on what was just made.
          const type = node.childForFieldName("type") ?? node.childForFieldName("constructor");
          const named = type && /^generic_(type|name)$/.test(type.type) ? type.namedChild(0) : type;
          const text = qualifierText(named);
          return text && text !== "?" && text !== "super" ? TYPED_PREFIX + text : null;
        }
        case "cast_expression": {
          // Java and C#: `((WildcardType) t).getUpperBounds()` is a call on a WildcardType.
          const cast = node.childForFieldName("type");
          const text = qualifierText(cast && /^generic_(type|name)$/.test(cast.type) ? cast.namedChild(0) : cast);
          return text && text !== "?" && text !== "super" ? TYPED_PREFIX + text : null;
        }
        case "ternary_expression":
        case "conditional_expression": {
          // `(a ? b : c).m()`: known only when both branches are the same kind of value.
          const named = node.namedChildren.filter((c): c is Node => c !== null);
          const [yes, no] = node.type === "ternary_expression" ? [named[1], named[2]] : [named[0], named[2]];
          if (!yes || !no) return null;
          const left = chainQualifier(yes, at, depth + 1);
          const right = chainQualifier(no, at, depth + 1);
          return left !== null && left === right && left.startsWith(TYPED_PREFIX) ? left : null;
        }
        case "call_expression":
        case "call":
        case "method_invocation":
        case "invocation_expression":
        case "member_call_expression":
        case "nullsafe_member_call_expression": {
          const parts = callParts(node);
          if (!parts) return null;
          if (!parts.receiver) return `${TYPED_PREFIX}()${parts.member}`;
          const receiver = chainQualifier(parts.receiver, at, depth + 1);
          return receiver === null ? null : `${TYPED_PREFIX}()${receiver} ${parts.member}`;
        }
        default: {
          const text = qualifierText(node);
          if (!text || text === "?" || text === "super") return null;
          return typedQualifier(text, at);
        }
      }
    };

    // Hints that belong to a type are its fields; other files follow them through `x.field.method()`.
    // They are written in their resolved form, since the hints they may lean on stay in this file.
    const fields: FieldHint[] = [];
    const fieldRank = new Map<string, number>();
    for (const hint of chosen.values()) {
      if (hint.types.size !== 1 || !hintScopeIsType(hint.scope)) continue;
      const key = `${hint.scope}\u0000${hint.name}`;
      if ((fieldRank.get(key) ?? -1) >= hint.rank) continue;
      const encoded = encodeHint({ type: [...hint.types][0]!, index: hint.index }, 0);
      if (!encoded) continue;
      fieldRank.set(key, hint.rank);
      const existing = fields.findIndex((f) => f.owner === hint.scope && f.name === hint.name);
      if (existing >= 0) fields.splice(existing, 1);
      fields.push({ owner: hint.scope, name: hint.name, type: encoded.slice(TYPED_PREFIX.length) });
    }

    const refs = new Map<string, RawRef>();
    const addRef = (kind: RefKind, name: string, qualifier: string | null, at: Node, subject?: string | null) => {
      const subjectId = subject ? `${path}#${subject}` : null;
      const src = subjectId && nodeById.has(subjectId) ? subjectId : (enclosingSymbol(at.startIndex)?.id ?? path);
      const key = `${src}\u0000${kind}\u0000${qualifier ?? ""}\u0000${name}`;
      const existing = refs.get(key);
      if (existing) existing.count++;
      else refs.set(key, { src, kind, name, qualifier, line: at.startPosition.row + 1, count: 1 });
    };

    const candidateNames = new Set<string>();
    for (const symbol of symbols) if (!symbol.parent && !symbol.owner) candidateNames.add(symbol.name);
    for (const imp of imports) for (const n of imp.names) if (n.local !== "*") candidateNames.add(n.local);

    for (const ref of refCaptures) {
      if (ref.kind === "ident" || ref.kind === "type") continue;
      if (insideImport(ref.node.startIndex)) continue;
      claimed.add(ref.nameNode.id);
      let qualifier = qualifierText(ref.qualifier);
      if (qualifier && spec.superNames?.has(qualifier)) qualifier = "super";
      if (qualifier && qualifier !== "?" && qualifier !== "super" && ref.kind === "call") {
        qualifier = typedQualifier(qualifier, ref.node.startIndex);
      } else if (qualifier === "?" && ref.qualifier && ref.kind === "call") {
        // A receiver that is a chain of calls: typed link by link where possible; otherwise say where it
        // starts, so that a chain off a third-party value is not guessed at.
        const chain = chainQualifier(ref.qualifier, ref.node.startIndex);
        if (chain) qualifier = chain;
        else {
          const root = receiverRoot(ref.qualifier, spec.selfNames);
          if (root) qualifier = UNKNOWN_PREFIX + typedQualifier(root, ref.node.startIndex);
        }
      }
      addRef(REF_KIND[ref.kind] ?? "references", ref.nameNode.text, qualifier, ref.nameNode, ref.subject);
    }
    // Calls the grammar does not show as such (a macro's tokens, a bare Ruby name): the language reads them.
    for (const node of spec.scanCalls ? scanned : []) {
      for (const call of spec.scanCalls!(node)) {
        const name = call.name.text;
        if (claimed.has(call.name.id) || ignored?.has(name)) continue;
        claimed.add(call.name.id);
        let qualifier = call.receiver;
        if (qualifier && spec.superNames?.has(qualifier)) qualifier = "super";
        if (qualifier && qualifier !== "?" && qualifier !== "super") {
          const typed = typedQualifier(qualifier, call.name.startIndex);
          qualifier = call.chained ? UNKNOWN_PREFIX + typed : typed;
        }
        addRef("calls", name, qualifier, call.name);
      }
    }
    // A type written with its package (`cart.Item`), unless a call or construction already covers it.
    for (const ref of refCaptures) {
      if (ref.kind !== "type" || !ref.qualifier) continue;
      if (claimed.has(ref.nameNode.id) || insideImport(ref.node.startIndex)) continue;
      claimed.add(ref.nameNode.id);
      addRef("type", ref.nameNode.text, qualifierText(ref.qualifier), ref.nameNode);
    }
    for (const ref of refCaptures) {
      if (ref.kind !== "ident" && ref.kind !== "type") continue;
      if (ref.qualifier || claimed.has(ref.node.id) || insideImport(ref.node.startIndex)) continue;
      const text = ref.node.text;
      if (ignored?.has(text)) continue;
      if (ref.kind === "type") {
        if (!typeParams.has(text)) addRef("type", text, null, ref.node);
      } else if ((candidateNames.has(text) || spec.keepIdent?.(text)) && spec.isIdentUsage(ref.node)) {
        addRef("references", text, null, ref.node);
      }
    }

    return {
      nodes,
      refs: [...refs.values()],
      imports,
      package: spec.packageOf?.(tree.rootNode) ?? null,
      syntaxError: firstErrorLine(tree.rootNode),
      fields,
    };
  } finally {
    tree.delete();
  }
}
