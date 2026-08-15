export type ActivityLogKind = "executing" | "result" | "completed" | "fail";

export interface ActivityLogEntry {
  id: string;
  connectionId: string;
  at: string;
  kind: ActivityLogKind;
  message: string;
}

type ActivityListener = (entry: ActivityLogEntry) => void;

const MAX_ENTRIES_PER_CONNECTION = 500;

export class ConnectionActivityLog {
  private readonly buffers = new Map<string, ActivityLogEntry[]>();
  private readonly listeners = new Set<ActivityListener>();
  private seq = 0;

  public append(
    connectionId: string,
    kind: ActivityLogKind,
    message: string,
  ): ActivityLogEntry {
    const entry: ActivityLogEntry = {
      id: `${Date.now()}-${++this.seq}`,
      connectionId,
      at: new Date().toISOString(),
      kind,
      message: String(message || ""),
    };

    const list = this.buffers.get(connectionId) ?? [];
    list.push(entry);
    if (list.length > MAX_ENTRIES_PER_CONNECTION) {
      list.splice(0, list.length - MAX_ENTRIES_PER_CONNECTION);
    }
    this.buffers.set(connectionId, list);

    for (const listener of this.listeners) {
      try {
        listener(entry);
      } catch {
        // ignore listener errors
      }
    }

    return entry;
  }

  public getEntries(connectionId: string): ActivityLogEntry[] {
    return [...(this.buffers.get(connectionId) ?? [])];
  }

  public onEntry(listener: ActivityListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  public clear(connectionId: string): void {
    this.buffers.delete(connectionId);
  }
}
