import { useEffect, useState } from "react";
import type { Api } from "../api";
import { hoverProps } from "../hover";
import { shortId } from "../ids";
import { kindName } from "../theme";
import type { GraphNode } from "../types";
import { NodeIcon } from "./NodeIcon";

export interface Hit extends GraphNode {
  /** Found by what the code does rather than by its name. */
  byMeaning?: boolean;
}

export interface SearchState {
  /** Null until an answer has come back for the text as it is now. */
  hits: Hit[] | null;
  /** True when no node matched every word, and these are the closest. */
  partial: boolean;
}

/** Ask the server as the text settles, dropping answers to text that has since changed. */
export function useSearch(api: Api, query: string, limit: number): SearchState {
  const [state, setState] = useState<SearchState>({ hits: null, partial: false });

  useEffect(() => {
    const text = query.trim();
    if (text === "") {
      setState({ hits: null, partial: false });
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      api
        .search(text, limit)
        .then((result) => {
          if (cancelled) return;
          setState({ hits: result.hits.map((h) => ({ ...h.node, byMeaning: h.byMeaning })), partial: result.partial });
        })
        .catch(() => !cancelled && setState({ hits: [], partial: false }));
    }, 160);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [api, query, limit]);

  return state;
}

/** One found node: its icon, its name, and where it lives. */
export function HitRow({ node, active, onChoose }: { node: Hit; active?: boolean; onChoose(id: string): void }) {
  // A symbol is placed by its file, a file by its folder; a folder's own id already says where it is.
  const where =
    node.kind === "directory" || node.kind === "external"
      ? ""
      : node.kind === "file"
        ? node.path.replace(/[^/]*$/, "")
        : node.path;
  return (
    <button
      type="button"
      className={`hit${active ? " active" : ""}`}
      title={node.id}
      onClick={() => onChoose(node.id)}
      {...hoverProps(node.id)}
    >
      <NodeIcon node={node} />
      <span className="hit-name">
        {node.byMeaning && (
          <span className="meaning" title="Found by what it does, not by its name">
            ≈{" "}
          </span>
        )}
        {node.kind === "directory" ? node.id : shortId(node.id)}
      </span>
      <span className="hit-where">{where}</span>
      <span className="hit-kind">{kindName(node)}</span>
    </button>
  );
}
