/**
 * Application-facing platform contracts.  These intentionally describe only
 * product operations; implementations must not leak SQL, Tauri invoke, or a
 * way to enumerate secret values.
 */

export interface Repository<Key, Entity> {
  findById(key: Key): Promise<Entity | undefined>;
  findAll(): Promise<readonly Entity[]>;
  insert(entity: Entity): Promise<Key>;
  save(entity: Entity): Promise<void>;
  delete(key: Key): Promise<boolean>;
  clear(): Promise<number>;
}

export interface SecretRef {
  category: string;
  entityId: string;
  field: string;
}

export interface SecretReader {
  get(ref: SecretRef): Promise<string | undefined>;
  isConfigured(ref: SecretRef): Promise<boolean>;
}

export interface SecretWriter {
  set(ref: SecretRef, value: string): Promise<void>;
  remove(ref: SecretRef): Promise<boolean>;
}

export type SecretStore = SecretReader & SecretWriter;

export type HttpMethod = "DELETE" | "GET" | "PATCH" | "POST" | "PUT";

export interface HttpRequest {
  resourceId: string;
  method: HttpMethod;
  path: string;
  body?: unknown;
}

export interface HttpResponse<T> {
  status: number;
  data: T;
  headers: Record<string, string>;
}

export interface HttpClient {
  request<T>(request: HttpRequest): Promise<HttpResponse<T>>;
}

export interface TaskScheduler {
  schedule(task: { id: string; kind: string; payload: Record<string, unknown>; runAt: number }): Promise<void>;
  cancel(taskId: string): Promise<boolean>;
}

export interface Clock {
  now(): number;
}

export interface Logger {
  debug(message: string, context?: Record<string, unknown>): void;
  error(message: string, error: unknown, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
}

export interface SettingsReader {
  get<T>(key: string): Promise<T | undefined>;
}

export class InMemoryRepository<Key, Entity extends { id?: Key }> implements Repository<Key, Entity> {
  private readonly entities = new Map<Key, Entity>();

  constructor(private readonly createKey: () => Key) {}

  async findById(key: Key): Promise<Entity | undefined> {
    return this.entities.get(key);
  }

  async findAll(): Promise<readonly Entity[]> {
    return [...this.entities.values()];
  }

  async insert(entity: Entity): Promise<Key> {
    const key = entity.id ?? this.createKey();
    this.entities.set(key, { ...entity, id: key });
    return key;
  }

  async save(entity: Entity): Promise<void> {
    if (entity.id === undefined) throw new Error("Repository entity id is required for save");
    this.entities.set(entity.id, { ...entity });
  }

  async delete(key: Key): Promise<boolean> {
    return this.entities.delete(key);
  }

  async clear(): Promise<number> {
    const count = this.entities.size;
    this.entities.clear();
    return count;
  }
}

function secretKey(ref: SecretRef): string {
  return `${ref.category}/${ref.entityId}/${ref.field}`;
}

export class InMemorySecretStore implements SecretStore {
  private readonly secrets = new Map<string, string>();

  async get(ref: SecretRef): Promise<string | undefined> {
    return this.secrets.get(secretKey(ref));
  }

  async isConfigured(ref: SecretRef): Promise<boolean> {
    return this.secrets.has(secretKey(ref));
  }

  async set(ref: SecretRef, value: string): Promise<void> {
    this.secrets.set(secretKey(ref), value);
  }

  async remove(ref: SecretRef): Promise<boolean> {
    return this.secrets.delete(secretKey(ref));
  }
}

export class InMemoryTaskScheduler implements TaskScheduler {
  readonly tasks = new Map<string, { id: string; kind: string; payload: Record<string, unknown>; runAt: number }>();

  async schedule(task: { id: string; kind: string; payload: Record<string, unknown>; runAt: number }): Promise<void> {
    this.tasks.set(task.id, { ...task, payload: { ...task.payload } });
  }

  async cancel(taskId: string): Promise<boolean> {
    return this.tasks.delete(taskId);
  }
}

export class InMemoryHttpClient implements HttpClient {
  private readonly responses = new Map<string, HttpResponse<unknown>>();

  respond<T>(request: Pick<HttpRequest, "method" | "path" | "resourceId">, response: HttpResponse<T>): void {
    this.responses.set(this.key(request), response);
  }

  async request<T>(request: HttpRequest): Promise<HttpResponse<T>> {
    const response = this.responses.get(this.key(request));
    if (!response) throw new Error(`No in-memory response registered for ${request.resourceId} ${request.method} ${request.path}`);
    return response as HttpResponse<T>;
  }

  private key(request: Pick<HttpRequest, "method" | "path" | "resourceId">): string {
    return `${request.resourceId}|${request.method}|${request.path}`;
  }
}

export class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }
}

export class InMemoryLogger implements Logger {
  readonly records: Array<{ level: "debug" | "error" | "info" | "warn"; message: string; context?: Record<string, unknown> }> = [];

  debug(message: string, context?: Record<string, unknown>): void {
    this.records.push({ level: "debug", message, context });
  }

  error(message: string, _error: unknown, context?: Record<string, unknown>): void {
    this.records.push({ level: "error", message, context });
  }

  info(message: string, context?: Record<string, unknown>): void {
    this.records.push({ level: "info", message, context });
  }

  warn(message: string, context?: Record<string, unknown>): void {
    this.records.push({ level: "warn", message, context });
  }
}
