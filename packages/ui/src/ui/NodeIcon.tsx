import { fileIcon, folderIcon } from "../fileIcons";
import { isDirectory, isSymbol } from "../ids";
import { KIND_COLORS, KIND_LETTERS } from "../theme";
import type { NodeKind } from "../types";

/** What is known of a node when only its icon is wanted; the id alone is enough for files and folders. */
export interface IconSubject {
  id: string;
  kind?: NodeKind | null;
  subkind?: string | null;
  language?: string | null;
}

/** A file's or a folder's picture, from vscode-icons. */
export function FileIcon({ path, language, size = 16 }: { path: string; language?: string | null; size?: number }) {
  return <img className="ficon" src={fileIcon(path, language)} alt="" width={size} height={size} draggable={false} />;
}

export function FolderIcon({ path, open = false, size = 16 }: { path: string; open?: boolean; size?: number }) {
  return <img className="ficon" src={folderIcon(path, open)} alt="" width={size} height={size} draggable={false} />;
}

/** The lettered badge of a symbol, in its kind's colour, as an editor's outline shows it. */
export function KindBadge({ kind, subkind, size = 16 }: { kind: NodeKind; subkind?: string | null; size?: number }) {
  const letter = kind === "type" && subkind === "enum" ? "E" : KIND_LETTERS[kind];
  return (
    <span
      className="kbadge"
      style={{ color: KIND_COLORS[kind], width: size, height: size, fontSize: Math.round(size * 0.62) }}
      aria-hidden="true"
    >
      {letter}
    </span>
  );
}

/** The right icon for any node: a folder, a file by its type, or a symbol's badge. */
export function NodeIcon({ node, open, size = 16 }: { node: IconSubject; open?: boolean; size?: number }) {
  const kind = node.kind ?? (isDirectory(node.id) ? "directory" : isSymbol(node.id) ? null : "file");
  if (node.id.startsWith("ext:") || kind === "external") {
    return node.id === "ext:" || node.subkind === "group" ? (
      <FolderIcon path="packages/" open={open} size={size} />
    ) : (
      <KindBadge kind="external" size={size} />
    );
  }
  if (kind === "directory") return <FolderIcon path={node.id} open={open} size={size} />;
  if (kind === "file") return <FileIcon path={node.id} language={node.language} size={size} />;
  if (kind === null)
    return <span className="kbadge unknown" style={{ width: size, height: size }} aria-hidden="true" />;
  return <KindBadge kind={kind} subkind={node.subkind} size={size} />;
}
