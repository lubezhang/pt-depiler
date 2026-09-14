import type { Repository } from "~/domain/ports/index.ts";

export type DownloadHistoryEvent<Record, Key> =
  | { type: "DownloadHistoryCleared"; count: number }
  | { type: "DownloadHistoryDeleted"; downloadId: Key }
  | { type: "DownloadHistoryUpdated"; history: Record }
  | { type: "DownloadStatusChanged"; downloadId: Key; history: Record; status: string };

export interface DownloadHistoryEventPublisher<Record, Key> {
  publish(event: DownloadHistoryEvent<Record, Key>): void;
}

export interface DownloadHistoryRecord<Key, Status extends string> {
  id?: Key;
  downloadStatus: Status;
}

export interface DownloadHistoryPersistencePolicy {
  isEnabled(): Promise<boolean>;
}

export class DownloadHistoryQueries<Key, Status extends string, Record extends DownloadHistoryRecord<Key, Status>> {
  constructor(private readonly repository: Repository<Key, Record>) {}

  async getById(downloadId: Key): Promise<Record | undefined> {
    return await this.repository.findById(downloadId);
  }

  async list(): Promise<readonly Record[]> {
    return await this.repository.findAll();
  }
}

export class DownloadHistoryCommands<Key, Status extends string, Record extends DownloadHistoryRecord<Key, Status>> {
  constructor(
    private readonly repository: Repository<Key, Record>,
    private readonly policy: DownloadHistoryPersistencePolicy,
    private readonly events: DownloadHistoryEventPublisher<Record, Key>,
  ) {}

  async create(history: Record): Promise<Key | undefined> {
    if (!(await this.policy.isEnabled())) return undefined;
    const downloadId = await this.repository.insert(history);
    const saved = { ...history, id: downloadId } as Record;
    this.events.publish({ type: "DownloadHistoryUpdated", history: saved });
    return downloadId;
  }

  async patch(downloadId: Key, patch: Partial<Record>): Promise<{ changed: boolean; history?: Record; stored: boolean }> {
    if (!(await this.policy.isEnabled())) return { changed: false, stored: false };
    const current = await this.repository.findById(downloadId);
    if (!current) return { changed: false, stored: true };
    const history = { ...current, ...patch, id: downloadId } as Record;
    if (Object.keys(patch).every((key) => Object.is(current[key as keyof Record], history[key as keyof Record]))) {
      return { changed: false, history: current, stored: true };
    }
    await this.repository.save(history);
    this.events.publish({ type: "DownloadHistoryUpdated", history });
    return { changed: true, history, stored: true };
  }

  async setStatus(downloadId: Key, status: Status): Promise<{ changed: boolean; history?: Record; stored: boolean }> {
    if (!(await this.policy.isEnabled())) return { changed: false, stored: false };
    const current = await this.repository.findById(downloadId);
    if (!current) return { changed: false, stored: true };
    const history = { ...current, downloadStatus: status, id: downloadId } as Record;
    const changed = current.downloadStatus !== status;

    // Legacy download attempts persist the pending checkpoint even when the
    // value is unchanged. Keep that write for recovery compatibility, while
    // avoiding duplicate UI events for an idempotent status transition.
    await this.repository.save(history);
    if (changed) {
      this.events.publish({ type: "DownloadHistoryUpdated", history });
      this.events.publish({ type: "DownloadStatusChanged", downloadId, history, status });
    }
    return { changed, history, stored: true };
  }

  async delete(downloadId: Key): Promise<boolean> {
    if (!(await this.policy.isEnabled())) return false;
    const deleted = await this.repository.delete(downloadId);
    if (deleted) this.events.publish({ type: "DownloadHistoryDeleted", downloadId });
    return deleted;
  }

  async clear(): Promise<number> {
    if (!(await this.policy.isEnabled())) return 0;
    const count = await this.repository.clear();
    if (count > 0) this.events.publish({ type: "DownloadHistoryCleared", count });
    return count;
  }
}
