import type { Snapshot, Op } from "@birga/crdt";

/** What we persist locally so a client survives reloads and offline periods. */
export interface PersistedDoc {
  /** The document state as of the last save. */
  snapshot: Snapshot;
  /** Highest server seq we had applied (what we pass as `since` on reconnect). */
  head: number;
  /** Local ops not yet confirmed by the server (resent on reconnect). */
  outbox: Op[];
}

/** Local persistence for offline-first editing. */
export interface Storage {
  load(docId: string): Promise<PersistedDoc | null>;
  save(docId: string, doc: PersistedDoc): Promise<void>;
}

/** Non-persistent store — used in tests and as a safe default. */
export class MemoryStorage implements Storage {
  private readonly map = new Map<string, PersistedDoc>();
  async load(docId: string): Promise<PersistedDoc | null> {
    return this.map.get(docId) ?? null;
  }
  async save(docId: string, doc: PersistedDoc): Promise<void> {
    this.map.set(docId, doc);
  }
}

/**
 * IndexedDB-backed storage for the browser. One object store keyed by docId.
 * Values are structured-clonable (plain JSON), so IndexedDB stores them directly.
 */
export class IndexedDBStorage implements Storage {
  private dbPromise: Promise<IDBDatabase> | null = null;

  constructor(
    private readonly dbName = "birga",
    private readonly storeName = "docs",
  ) {}

  private db(): Promise<IDBDatabase> {
    if (!this.dbPromise) {
      this.dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(this.dbName, 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(this.storeName)) db.createObjectStore(this.storeName);
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return this.dbPromise;
  }

  async load(docId: string): Promise<PersistedDoc | null> {
    const db = await this.db();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, "readonly");
      const req = tx.objectStore(this.storeName).get(docId);
      req.onsuccess = () => resolve((req.result as PersistedDoc | undefined) ?? null);
      req.onerror = () => reject(req.error);
    });
  }

  async save(docId: string, doc: PersistedDoc): Promise<void> {
    const db = await this.db();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, "readwrite");
      tx.objectStore(this.storeName).put(doc, docId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
}
