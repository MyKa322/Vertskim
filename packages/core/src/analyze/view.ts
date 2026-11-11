import type { GraphStore } from "../store/store.js";
import type { EdgeKind, NodeKind } from "../types.js";

/** A node as drawn: either a single thing, or a collapsed container standing for everything inside it. */
export interface ViewNode {
  id: string;
  kind: NodeKind;
  subkind: string | null;
  name: string;
  path: string;
  language: string | null;
  /** The expanded container this node is drawn inside, if any. */
  parent: string | null;
  /** True when the node has contents that can be shown. */
  container: boolean;
  /** True when its contents are shown; such a node is drawn as a small hub. */
  expanded: boolean;
  /** Files at or beneath the node. */
  files: number;
  /** Symbols and sections beneath the node. */
  symbols: number;
  /** Relationships arriving from outside the node, summed over everything inside it. */
  fanIn: number;
  /** Top-level directory, for colouring by area. */
  group: string;
}

export interface ViewLink {
  source: string;
  target: string;
  kind: EdgeKind;
  /** How many underlying relationships this line stands for. */
  weight: number;
  /** True when every one of them was matched by name only. */
  heuristic: boolean;
}

export interface GraphView {
  /** Changes whenever the graph does. */
  version: string;
  root: string;
  nodes: ViewNode[];
  links: ViewLink[];
  /** Containers whose contents are shown; send back to keep the same view. */
  expanded: string[];
  /** True when a size limit kept something from being shown. */
  truncated: boolean;
}

export interface ViewOptions {
  /** Directory the view is rooted at. Default: the project root. */
  root?: string;
  /** Containers to open. Omit to let the builder choose a readable starting view. */
  expanded?: string[];
  /** Most nodes to return. */
  maxNodes?: number;
}

interface SnapNode {
  id: string;
  kind: NodeKind;
  subkind: string | null;
  name: string;
  path: string;
  language: string | null;
  parent: string | null;
  children: string[];
  files: number;
  symbols: number;
}

interface SnapEdge {
  src: string;
  dst: string;
  kind: EdgeKind;
  weight: number;
  heuristic: boolean;
}

interface Snapshot {
  version: string;
  nodes: Map<string, SnapNode>;
  edges: SnapEdge[];
}

/** Synthetic container that keeps third-party modules together instead of scattered round the root. */
export const EXTERNAL_GROUP = "ext:";
const ROOT = "./";
/** Size of the view chosen when the caller does not say what to open. */
const DEFAULT_TARGET = 220;
const DEFAULT_MAX_NODES = 1500;
const LINKS_PER_NODE = 4;

/**
 * Builds drawable views of the graph. A view shows some containers opened and
 * the rest collapsed, with every relationship re-attached to the nearest thing
 * that is actually drawn, so a large project stays readable at any zoom level.
 *
 * Holds the whole graph in memory, reloaded when the graph version changes.
 */
export class ViewBuilder {
  private snapshot: Snapshot | null = null;

  constructor(private readonly store: GraphStore) {}

  version(): string {
    return this.store.getMeta("graph_version") ?? "0";
  }

  private load(): Snapshot {
    const version = this.version();
    if (this.snapshot?.version === version) return this.snapshot;

    const nodes = new Map<string, SnapNode>();
    for (const row of this.store.stmt("SELECT id, kind, subkind, name, path, parent, language FROM nodes").all()) {
      nodes.set(row.id as string, {
        id: row.id as string,
        kind: row.kind as NodeKind,
        subkind: (row.subkind as string | null) ?? null,
        name: row.name as string,
        path: row.path as string,
        language: (row.language as string | null) ?? null,
        parent: (row.parent as string | null) ?? null,
        children: [],
        files: 0,
        symbols: 0,
      });
    }
    if (!nodes.has(ROOT)) {
      nodes.set(ROOT, { id: ROOT, kind: "directory", subkind: null, name: ".", path: "", language: null, parent: null, children: [], files: 0, symbols: 0 });
    }
    let hasExternal = false;
    for (const node of nodes.values()) {
      if (node.kind === "external") {
        node.parent = EXTERNAL_GROUP;
        hasExternal = true;
      }
    }
    if (hasExternal) {
      nodes.set(EXTERNAL_GROUP, {
        id: EXTERNAL_GROUP,
        kind: "external",
        subkind: "group",
        name: "external modules",
        path: "",
        language: null,
        parent: ROOT,
        children: [],
        files: 0,
        symbols: 0,
      });
    }
    for (const node of nodes.values()) {
      if (node.parent === null) continue;
      const parent = nodes.get(node.parent);
      if (parent) parent.children.push(node.id);
      else node.parent = null;
    }

    // Sizes, children before parents.
    const order: SnapNode[] = [];
    const stack = [nodes.get(ROOT)!];
    while (stack.length > 0) {
      const node = stack.pop()!;
      order.push(node);
      for (const child of node.children) stack.push(nodes.get(child)!);
    }
    for (let i = order.length - 1; i >= 0; i--) {
      const node = order[i]!;
      if (node.kind === "file") node.files += 1;
      else if (node.kind !== "directory" && node.kind !== "external") node.symbols += 1;
      const parent = node.parent ? nodes.get(node.parent) : undefined;
      if (parent) {
        parent.files += node.files;
        parent.symbols += node.symbols;
      }
    }
    for (const node of nodes.values()) node.children.sort();

    const edges: SnapEdge[] = [];
    for (const row of this.store
      .stmt("SELECT src, dst, kind, weight, confidence FROM edges WHERE kind != 'contains'")
      .all()) {
      if (!nodes.has(row.src as string) || !nodes.has(row.dst as string)) continue;
      edges.push({
        src: row.src as string,
        dst: row.dst as string,
        kind: row.kind as EdgeKind,
        weight: row.weight as number,
        heuristic: row.confidence === "heuristic",
      });
    }
    this.snapshot = { version, nodes, edges };
    return this.snapshot;
  }

  /** Containers to open, outermost first, so that `id` becomes visible. */
  reveal(id: string): string[] {
    const { nodes } = this.load();
    const chain: string[] = [];
    let cursor = nodes.get(id)?.parent ?? null;
    while (cursor !== null && cursor !== ROOT) {
      chain.unshift(cursor);
      cursor = nodes.get(cursor)?.parent ?? null;
    }
    return chain;
  }

  build(options: ViewOptions = {}): GraphView {
    const snapshot = this.load();
    const { nodes, edges } = snapshot;
    const maxNodes = Math.min(Math.max(options.maxNodes ?? DEFAULT_MAX_NODES, 10), 5000);
    const root = nodes.get(options.root ?? ROOT)?.kind === "directory" ? nodes.get(options.root ?? ROOT)! : nodes.get(ROOT)!;
    let truncated = false;

    // ---- which containers are open
    const open = new Set<string>();
    if (options.expanded) {
      for (const id of options.expanded) if ((nodes.get(id)?.children.length ?? 0) > 0) open.add(id);
    } else {
      // Open the biggest directories first until the picture is full enough to read;
      // a project small enough to show whole gets its files opened too.
      let shown = root.children.length;
      const consider = (kinds: (kind: NodeKind) => boolean) => {
        for (;;) {
          let best: SnapNode | null = null;
          const visit = (id: string) => {
            for (const childId of nodes.get(id)!.children) {
              const child = nodes.get(childId)!;
              if (open.has(childId)) visit(childId);
              else if (child.children.length > 0 && kinds(child.kind) && child.id !== EXTERNAL_GROUP) {
                if (shown + child.children.length > DEFAULT_TARGET) continue;
                if (!best || child.files > best.files || (child.files === best.files && child.symbols > best.symbols)) {
                  best = child;
                }
              }
            }
          };
          visit(root.id);
          if (!best) return;
          open.add((best as SnapNode).id);
          shown += (best as SnapNode).children.length;
        }
      };
      consider((kind) => kind === "directory");
      if (shown < DEFAULT_TARGET / 2) consider((kind) => kind === "file");
    }

    // ---- which nodes are drawn
    const drawn = new Map<string, ViewNode>();
    // Areas, for colouring. Normally the top-level directories; but when one of them holds
    // most of the project (`src/`, `packages/`) it is split into its own subdirectories,
    // or every node would get the same colour.
    const split = new Set<string>([root.id]);
    for (let cursor: SnapNode | undefined = root; cursor; ) {
      const dirs: SnapNode[] = cursor.children.map((id) => nodes.get(id)!).filter((n) => n.kind === "directory");
      const total: number = cursor.files;
      const dominant: SnapNode | undefined = dirs.find(
        (dir) => dir.files > total * 0.6 && dir.children.some((id) => nodes.get(id)!.kind === "directory"),
      );
      if (dominant) split.add(dominant.id);
      cursor = dominant;
    }
    const groupOf = (node: SnapNode): string => {
      if (node.id.startsWith("ext:")) return EXTERNAL_GROUP;
      // Walk down from the root through the split directories towards the node's path.
      let area = root.id;
      let prefix = root.path;
      for (;;) {
        const rest = node.path.slice(prefix.length);
        const slash = rest.indexOf("/");
        if (slash < 0) return area;
        const next = `${prefix}${rest.slice(0, slash)}/`;
        if (!split.has(next)) return next;
        area = next;
        prefix = next;
      }
    };
    const draw = (node: SnapNode, parent: string | null, expanded: boolean) => {
      drawn.set(node.id, {
        id: node.id,
        kind: node.kind,
        subkind: node.subkind,
        name: node.name,
        path: node.path,
        language: node.language,
        parent,
        container: node.children.length > 0,
        expanded,
        files: node.files,
        symbols: node.symbols,
        fanIn: 0,
        group: groupOf(node),
      });
    };
    const walk = (container: SnapNode, hub: string | null) => {
      for (const childId of container.children) {
        const child = nodes.get(childId)!;
        const wantsOpen = open.has(childId) && child.children.length > 0;
        if (drawn.size >= maxNodes) {
          truncated = true;
          return;
        }
        if (wantsOpen && drawn.size + 1 + child.children.length <= maxNodes) {
          draw(child, hub, true);
          walk(child, child.id);
        } else {
          if (wantsOpen) truncated = true;
          draw(child, hub, false);
        }
      }
    };
    walk(root, null);

    // ---- relationships, re-attached to whatever is drawn
    const anchors = new Map<string, string | null>();
    const anchor = (id: string): string | null => {
      const known = anchors.get(id);
      if (known !== undefined) return known;
      let cursor: string | null = id;
      let found: string | null = null;
      while (cursor !== null) {
        if (drawn.has(cursor)) {
          found = cursor;
          break;
        }
        cursor = nodes.get(cursor)?.parent ?? null;
      }
      anchors.set(id, found);
      return found;
    };
    /** True when `inner` is drawn somewhere inside the hub `outer`. */
    const within = (inner: string, outer: string): boolean => {
      let cursor = drawn.get(inner)?.parent ?? null;
      while (cursor !== null) {
        if (cursor === outer) return true;
        cursor = drawn.get(cursor)?.parent ?? null;
      }
      return false;
    };

    const links = new Map<string, ViewLink>();
    for (const edge of edges) {
      const source = anchor(edge.src);
      const target = anchor(edge.dst);
      if (source === null || target === null || source === target) continue;
      // A hub and something inside it are already joined by the containment line.
      if (within(source, target) || within(target, source)) continue;
      drawn.get(target)!.fanIn += 1;
      const key = `${source}\u0000${target}\u0000${edge.kind}`;
      const existing = links.get(key);
      if (existing) {
        existing.weight += edge.weight;
        existing.heuristic &&= edge.heuristic;
      } else {
        links.set(key, { source, target, kind: edge.kind, weight: edge.weight, heuristic: edge.heuristic });
      }
    }
    let dependencyLinks = [...links.values()];
    const linkLimit = drawn.size * LINKS_PER_NODE;
    if (dependencyLinks.length > linkLimit) {
      dependencyLinks = dependencyLinks.sort((a, b) => b.weight - a.weight).slice(0, linkLimit);
      truncated = true;
    }
    const structure: ViewLink[] = [];
    for (const node of drawn.values()) {
      if (node.parent !== null) {
        structure.push({ source: node.parent, target: node.id, kind: "contains", weight: 1, heuristic: false });
      }
    }

    return {
      version: snapshot.version,
      root: root.id,
      nodes: [...drawn.values()],
      links: [...structure, ...dependencyLinks],
      expanded: [...drawn.values()].filter((n) => n.expanded).map((n) => n.id),
      truncated,
    };
  }
}
