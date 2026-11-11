import type { Node, Query } from "@vscode/tree-sitter-wasm";
import { SELF_QUALIFIER, TYPED_PREFIX, type Extraction, type GraphNode, type ImportDecl, type RawRef, type RefKind } from "../types.js";
import { getParser, getRuntime, loadLanguage } from "./runtime.js";
import type { LanguageSpec, RawDef, SymbolInfo } from "./spec.js";

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

/** A variable, parameter or field whose type is written down. */
interface TypeHint {
  type: string;
  index: number;
}

const TYPE_KINDS = new Set(["class", "interface", "type"]);

/** Reduce a receiver expression to something the resolver can look up, or `?`. */
function qualifierText(node: Node | null): string | null {
  if (!node) return null;
  // Path separators of other languages (`a::b`) are stored the same way as `a.b`.
  const text = node.text.replace(/\s*::\s*/g, ".");
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
  const tree = parser.parse(source);
  if (!tree) return { nodes: [], refs: [], imports: [] };
  const ignored = spec.ignoredNames;

  try {
    const rawDefs = new Map<number, RawDef>();
    const refCaptures: RefCapture[] = [];
    const importNodes = new Map<number, Node>();
    const exportNames: { name: string; isDefault: boolean }[] = [];
    const typeParams = new Set<string>();
    const rawHints: { name: string; type: string; index: number }[] = [];

    for (const match of query.matches(tree.rootNode)) {
      let nameNode: Node | null = null;
      let qualifier: Node | null = null;
      let subject: string | null = null;
      let varNode: Node | null = null;
      let varType: Node | null = null;
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
        else if (cn.startsWith("export.")) exp = cn.slice(7);
        else if (cn === "typeparam") typeParams.add(capture.node.text);
        else if (cn === "subject") subject = capture.node.text;
        else if (cn === "var") varNode = capture.node;
        else if (cn === "vartype") varType = capture.node;
      }
      if (varNode && varType) {
        rawHints.push({ name: varNode.text, type: varType.text, index: varNode.startIndex });
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
      for (let a = def.node.parent; a; a = a.parent) {
        const enclosing = kept.get(a.id);
        if (enclosing) {
          parent = enclosing;
          break;
        }
        if (skipped.has(a.id) || spec.scopeBreakers.has(a.type)) {
          blocked = true;
          break;
        }
      }
      const decision = blocked ? null : spec.classify(def, parent);
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
    for (const hint of rawHints) {
      if (ignored?.has(hint.type)) continue;
      const scope = enclosingSymbol(hint.index)?.id ?? path;
      let byName = hints.get(scope);
      if (!byName) hints.set(scope, (byName = new Map()));
      const list = byName.get(hint.name);
      if (list) list.push({ type: hint.type, index: hint.index });
      else byName.set(hint.name, [{ type: hint.type, index: hint.index }]);
    }
    /**
     * Replace a receiver the file says enough about: the method's own receiver
     * variable, or a variable or field whose type is written down.
     */
    const typedQualifier = (qualifier: string, at: number): string => {
      const enclosing = enclosingSymbol(at);
      const isSelf = (name: string) => {
        if (spec.selfNames.has(name)) return true;
        for (let s = enclosing; s; s = s.parent) if (s.selfName === name) return true;
        return false;
      };
      let name = qualifier;
      let fieldOnly = false;
      const dot = qualifier.indexOf(".");
      if (dot < 0) {
        if (spec.selfNames.has(qualifier)) return qualifier;
        if (isSelf(qualifier)) return SELF_QUALIFIER;
      } else {
        const rest = qualifier.slice(dot + 1);
        if (rest.includes(".") || !isSelf(qualifier.slice(0, dot))) return qualifier;
        name = rest;
        fieldOnly = true;
      }
      if (hints.size === 0) return qualifier;
      const scopes: string[] = [];
      for (let s = enclosing; s; s = s.parent) {
        if (!fieldOnly || TYPE_KINDS.has(s.kind)) scopes.push(s.id);
        if (s.owner) scopes.push(`${path}#${s.owner}`);
      }
      if (!fieldOnly) scopes.push(path);
      for (const scope of scopes) {
        const list = hints.get(scope)?.get(name);
        if (!list) continue;
        let best = list[0]!;
        for (const hint of list) if (hint.index <= at) best = hint;
        return TYPED_PREFIX + best.type;
      }
      return qualifier;
    };

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
      }
      addRef(REF_KIND[ref.kind] ?? "references", ref.nameNode.text, qualifier, ref.nameNode, ref.subject);
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

    return { nodes, refs: [...refs.values()], imports, package: spec.packageOf?.(tree.rootNode) ?? null };
  } finally {
    tree.delete();
  }
}
