import type { GraphView, NodePayload, NotesPayload, SearchPayload, ServerStatus, SourcePayload, TrailEvent } from "./types";

const TOKEN_KEY = "vertskim-token";

/** Thrown when the server does not accept this page's token. */
export class AuthError extends Error {}

/**
 * The token arrives in the page link. It is moved into session storage and
 * taken out of the address bar straight away, so it does not linger in history
 * or get copied along with the address.
 */
export function takeToken(): string | null {
  const url = new URL(window.location.href);
  const fromLink = url.searchParams.get("t");
  if (fromLink) {
    try {
      sessionStorage.setItem(TOKEN_KEY, fromLink);
    } catch {
      // storage unavailable: the token still works until the page is reloaded
    }
    url.searchParams.delete("t");
    window.history.replaceState(null, "", url.pathname + url.search + url.hash);
    return fromLink;
  }
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export interface EventHandlers {
  onHello(status: ServerStatus, trail: TrailEvent[]): void;
  onChanged(status: ServerStatus): void;
  onStatus(status: ServerStatus): void;
  onTrail(event: TrailEvent): void;
  onFocus(id: string): void;
  /** A note was added or removed somewhere. */
  onNotes(): void;
  onConnection(live: boolean): void;
}

export class Api {
  constructor(private readonly token: string) {}

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(path, {
      ...init,
      headers: { ...init?.headers, Authorization: `Bearer ${this.token}` },
    });
    if (response.status === 401) throw new AuthError("This link is no longer valid.");
    if (!response.ok) {
      let message = `${response.status} ${response.statusText}`;
      try {
        const body = (await response.json()) as { error?: string };
        if (body.error) message = body.error;
      } catch {
        // not JSON
      }
      throw new Error(message);
    }
    return (await response.json()) as T;
  }

  status(): Promise<ServerStatus> {
    return this.request("/api/status");
  }

  view(body: { root?: string; expanded?: string[] }): Promise<GraphView> {
    return this.request("/api/view", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  node(id: string): Promise<NodePayload> {
    return this.request(`/api/node?id=${encodeURIComponent(id)}`);
  }

  source(id: string): Promise<SourcePayload> {
    return this.request(`/api/source?id=${encodeURIComponent(id)}`);
  }

  search(query: string): Promise<SearchPayload> {
    return this.request(`/api/search?q=${encodeURIComponent(query)}&limit=12`);
  }

  reveal(id: string): Promise<{ id: string; expand: string[] }> {
    return this.request(`/api/reveal?id=${encodeURIComponent(id)}`);
  }

  notes(): Promise<NotesPayload> {
    return this.request("/api/notes");
  }

  addNote(id: string, text: string): Promise<unknown> {
    return this.request("/api/notes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, text }),
    });
  }

  removeNote(note: number): Promise<unknown> {
    return this.request("/api/notes/remove", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ note }),
    });
  }

  /** Subscribe to live updates. The browser reconnects on its own; returns a function that stops it. */
  events(handlers: EventHandlers): () => void {
    const source = new EventSource(`/api/events?t=${encodeURIComponent(this.token)}`);
    const parse = <T,>(event: MessageEvent): T => JSON.parse(event.data as string) as T;
    source.addEventListener("hello", (e) => {
      const data = parse<{ status: ServerStatus; trail: TrailEvent[] }>(e);
      handlers.onConnection(true);
      handlers.onHello(data.status, data.trail);
    });
    source.addEventListener("changed", (e) => handlers.onChanged(parse<{ status: ServerStatus }>(e).status));
    source.addEventListener("status", (e) => handlers.onStatus(parse<{ status: ServerStatus }>(e).status));
    source.addEventListener("trail", (e) => handlers.onTrail(parse<TrailEvent>(e)));
    source.addEventListener("focus", (e) => handlers.onFocus(parse<{ id: string }>(e).id));
    source.addEventListener("notes", () => handlers.onNotes());
    source.onerror = () => handlers.onConnection(false);
    return () => source.close();
  }
}
