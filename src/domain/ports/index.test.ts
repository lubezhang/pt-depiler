import { describe, expect, it } from "vitest";

import {
  InMemoryHttpClient,
  InMemoryRepository,
  InMemorySecretStore,
  InMemoryTaskScheduler,
} from "./index.ts";

describe("领域端口内存实现", () => {
  it("Repository 只提供受约束的实体读写操作", async () => {
    let id = 0;
    const repository = new InMemoryRepository<number, { id?: number; title: string }>(() => ++id);
    const key = await repository.insert({ title: "torrent" });

    await repository.save({ id: key, title: "updated" });
    await expect(repository.findById(key)).resolves.toEqual({ id: key, title: "updated" });
    await expect(repository.clear()).resolves.toBe(1);
  });

  it("SecretStore 只能按引用读取，不暴露枚举明文的能力", async () => {
    const store = new InMemorySecretStore();
    const ref = { category: "downloader", entityId: "local", field: "password" };
    await store.set(ref, "not-for-logs");

    await expect(store.isConfigured(ref)).resolves.toBe(true);
    await expect(store.get(ref)).resolves.toBe("not-for-logs");
    expect("list" in store).toBe(false);
    await expect(store.remove(ref)).resolves.toBe(true);
  });

  it("HttpClient 始终要求资源身份，任务调度只接受可持久化 payload", async () => {
    const http = new InMemoryHttpClient();
    http.respond(
      { resourceId: "site:demo", method: "GET", path: "/api/search" },
      { data: { ok: true }, headers: {}, status: 200 },
    );
    await expect(http.request({ resourceId: "site:demo", method: "GET", path: "/api/search" })).resolves.toMatchObject({
      status: 200,
    });

    const scheduler = new InMemoryTaskScheduler();
    await scheduler.schedule({ id: "retry-1", kind: "redownload", payload: { downloadId: 1 }, runAt: 1 });
    await expect(scheduler.cancel("retry-1")).resolves.toBe(true);
  });
});
