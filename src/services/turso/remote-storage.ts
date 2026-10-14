/**
 * Remote memory storage: the same plugin, but memories live on another machine
 * behind the plugin's own HTTP API.
 *
 * Why a service-level client and not a database driver: the fork reaches its
 * store through libsql `file:` URLs and issues arbitrary SQL (vector_distance_cos,
 * vector_extract, transactions). None of that can be proxied over REST, so the
 * driver idea is not merely hard, it is impossible. What is proxied instead is
 * the set of operations the plugin actually performs -- the same set the server
 * already exposes under /api.
 *
 * The server embeds, so this client never touches ONNX: /api/search takes the
 * query as text and embeds it server-side, and /api/memories POST stores the
 * content and embeds it there. That is what lets the client drop its local
 * model.
 *
 * Configuration is passed in rather than read from CONFIG, so this module can be
 * exercised without a plugin instance.
 */

import { CONFIG } from "../../config.js";

export interface RemoteStorageConfig {
  enabled: boolean;
  baseUrl: string;
  apiToken?: string;
  timeoutMs: number;
}

export interface RemoteMemoryRecord {
  id: string;
  content: string;
  containerTag?: string;
  tags?: string[];
  type?: string;
  createdAt?: number;
  updatedAt?: number;
  isPinned?: boolean;
  metadata?: unknown;
  sessionId?: string;
  similarity?: number;
  displayName?: string;
  userName?: string;
  userEmail?: string;
  projectPath?: string;
  projectName?: string;
  gitRepoUrl?: string;
}

export interface RemoteSearchOptions {
  tags?: string[];
  page?: number;
  pageSize?: number;
  includePrompts?: boolean;
}

export class RemoteStorageError extends Error {
  readonly status: number;
  readonly path: string;
  constructor(message: string, status: number, path: string) {
    super(message);
    this.name = "RemoteStorageError";
    this.status = status;
    this.path = path;
  }
}

type FetchLike = typeof fetch;

export interface RemoteStorageClient {
  search(query: string, options?: RemoteSearchOptions): Promise<RemoteMemoryRecord[]>;
  getMemoryById(id: string): Promise<RemoteMemoryRecord | null>;
  listMemories(tags: string[], page: number, pageSize: number): Promise<RemoteMemoryRecord[]>;
  getTags(): Promise<{ tag: string }[]>;
  stats(): Promise<Record<string, unknown>>;
  addMemory(
    data: RemoteMemoryRecord & { content: string; containerTag: string }
  ): Promise<{ id: string }>;
  updateMemory(
    id: string,
    data: { content?: string; type?: string; tags?: string[] }
  ): Promise<void>;
  deleteMemory(id: string, cascade?: boolean): Promise<void>;
  getProfile(userId?: string): Promise<Record<string, unknown> | null>;
  putProfile(payload: {
    userId?: string;
    profileData: Record<string, unknown>;
    promptsAnalyzed?: number;
    changeSummary?: string;
  }): Promise<{ profileId: string; version: number; created: boolean }>;
}

const trimBase = (baseUrl: string): string => baseUrl.replace(/\/+$/, "");

/**
 * The one place that decides whether this process talks to a remote store.
 *
 * It lives here rather than in client.ts so that low-level callers (the profile
 * manager) can reach it without importing the client: that dependency direction
 * is what would turn a future import in client.ts into a cycle.
 *
 * The factory takes its configuration as an argument so it can be exercised
 * without a plugin instance; this accessor is the one that reads CONFIG.
 */
let cached: RemoteStorageClient | null = null;
let resolved = false;

export function getRemoteStore(): RemoteStorageClient | null {
  if (!resolved) {
    resolved = true;
    cached = CONFIG.remoteStorage?.enabled ? createRemoteStorageClient(CONFIG.remoteStorage) : null;
  }
  return cached;
}

export function resetRemoteStore(): void {
  cached = null;
  resolved = false;
}

/**
 * Read path only. Writes land in the same file as the second half of this work;
 * until they exist, remoteStorage.enabled must stay false, or the client would
 * write memories locally while reading them from the server and silently split
 * the store in two.
 */
export function createRemoteStorageClient(
  config: RemoteStorageConfig,
  fetchImpl?: FetchLike
): RemoteStorageClient {
  if (!config.enabled) {
    throw new Error("createRemoteStorageClient called while remote storage is disabled");
  }
  if (!config.baseUrl) {
    throw new Error("remoteStorage.baseUrl is required when remote storage is enabled");
  }
  const doFetch = fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== "function") {
    throw new Error("no fetch implementation available for remote storage");
  }
  const base = trimBase(config.baseUrl);

  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const url = `${base}${path}`;
    const headers: Record<string, string> = {
      accept: "application/json",
      ...((init?.headers as Record<string, string>) ?? {}),
    };
    if (init?.body) headers["content-type"] = "application/json";
    // The server expects this header, not Authorization: Bearer.
    if (config.apiToken) headers["x-opencode-mem-token"] = config.apiToken;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);
    let response: Response;
    try {
      response = await doFetch(url, { ...init, headers, signal: controller.signal });
    } catch (err) {
      // Network failure and timeout are indistinguishable to the caller on
      // purpose: both mean "the store is unreachable right now", and the caller
      // decides whether to degrade or to fail.
      throw new RemoteStorageError(
        `remote storage unreachable: ${String((err as Error)?.message ?? err)}`,
        0,
        path
      );
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      throw new RemoteStorageError(
        `remote storage returned ${response.status} for ${path}`,
        response.status,
        path
      );
    }
    const text = await response.text();
    if (!text) return {} as T;
    const body = JSON.parse(text) as { success?: boolean; error?: string; data?: T };
    // The plugin's own envelope: a 200 with success:false is a failure, and
    // reading data anyway would hand back undefined as if it were an empty store.
    if (body && body.success === false) {
      throw new RemoteStorageError(
        `remote storage rejected ${path}: ${body.error ?? "unknown error"}`,
        response.status,
        path
      );
    }
    return (body?.data ?? body) as T;
  }

  const paginated = (data: unknown): RemoteMemoryRecord[] => {
    const anyData = data as { items?: unknown[]; memories?: unknown[]; results?: unknown[] };
    return (anyData?.items ?? anyData?.memories ?? anyData?.results ?? []) as RemoteMemoryRecord[];
  };

  return {
    async search(query, options = {}) {
      const params = new URLSearchParams();
      params.set("q", query);
      for (const tag of options.tags ?? []) params.append("tag", tag);
      if (options.page) params.set("page", String(options.page));
      if (options.pageSize) params.set("pageSize", String(options.pageSize));
      // Prompts are not migrated memory; asking for them only inflates the payload.
      params.set("includePrompts", String(options.includePrompts ?? false));
      const data = await request<unknown>(`/api/search?${params.toString()}`);
      return paginated(data);
    },
    async getMemoryById(id) {
      const data = await request<RemoteMemoryRecord | null>(
        `/api/memories/${encodeURIComponent(id)}`
      );
      return data ?? null;
    },
    async listMemories(tags, page, pageSize) {
      const params = new URLSearchParams();
      for (const tag of tags) params.append("tag", tag);
      params.set("page", String(page));
      params.set("pageSize", String(pageSize));
      const data = await request<unknown>(`/api/memories?${params.toString()}`);
      return paginated(data);
    },
    async getTags() {
      return await request<{ tag: string }[]>("/api/tags");
    },
    async stats() {
      return await request<Record<string, unknown>>("/api/stats");
    },

    // Writes. The container tag travels with the memory because the server files
    // records under the tag it is given (handleAddMemory requires it) -- it never
    // guesses which project a memory belongs to. That is what makes a shared
    // store possible: each client keeps its own scope, the server stores both.
    // The server embeds, so no vector is computed here.
    async addMemory(data) {
      return await request<{ id: string }>("/api/memories", {
        method: "POST",
        body: JSON.stringify(data),
      });
    },
    async updateMemory(id, data) {
      await request(`/api/memories/${encodeURIComponent(id)}`, {
        method: "PUT",
        body: JSON.stringify(data),
      });
    },
    async deleteMemory(id, cascade = false) {
      const suffix = cascade ? "?cascade=true" : "";
      await request(`/api/memories/${encodeURIComponent(id)}${suffix}`, { method: "DELETE" });
    },

    // raw=1 is what makes this round trip lossless. The default profile view is
    // stripped of centroid/anchor for display; a client that merged and wrote
    // that back would silently lose the vectors its similarity match relies on.
    async getProfile(userId) {
      const params = new URLSearchParams({ raw: "1" });
      if (userId) params.set("userId", userId);
      const data = await request<{ exists?: boolean } & Record<string, unknown>>(
        `/api/user-profile?${params.toString()}`
      );
      return data && data.exists === true ? data : null;
    },
    async putProfile(payload) {
      return await request<{ profileId: string; version: number; created: boolean }>(
        "/api/user-profile",
        { method: "PUT", body: JSON.stringify(payload) }
      );
    },
  };
}
