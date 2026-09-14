import { describe, expect, it, vi } from "vitest";

import { InMemoryRepository } from "~/domain/ports/index.ts";
import { DownloadHistoryCommands, DownloadHistoryQueries, type DownloadHistoryEvent } from "./service.ts";

type History = { id?: number; downloadStatus: "pending" | "completed" | "failed"; title: string };

describe("下载历史用例", () => {
  it("成功写入后发布状态事件，重复状态写入保持幂等", async () => {
    let nextId = 0;
    const repository = new InMemoryRepository<number, History>(() => ++nextId);
    const publish = vi.fn<(event: DownloadHistoryEvent<History, number>) => void>();
    const commands = new DownloadHistoryCommands(repository, { isEnabled: async () => true }, { publish });
    const queries = new DownloadHistoryQueries(repository);
    const id = await commands.create({ downloadStatus: "pending", title: "torrent" });

    const first = await commands.setStatus(id!, "completed");
    const second = await commands.setStatus(id!, "completed");

    expect(first).toMatchObject({ changed: true, stored: true });
    expect(second).toMatchObject({ changed: false, stored: true });
    expect(await queries.getById(id!)).toMatchObject({ downloadStatus: "completed" });
    expect(publish.mock.calls.map(([event]) => event.type)).toEqual([
      "DownloadHistoryUpdated",
      "DownloadHistoryUpdated",
      "DownloadStatusChanged",
    ]);
  });

  it("存储失败会传播，未持久化配置不会伪造成功状态", async () => {
    const repository = new InMemoryRepository<number, History>(() => 1);
    const commands = new DownloadHistoryCommands(repository, { isEnabled: async () => false }, { publish: vi.fn() });
    await expect(commands.setStatus(1, "failed")).resolves.toMatchObject({ changed: false, stored: false });

    const failingRepository = new InMemoryRepository<number, History>(() => 1);
    await failingRepository.insert({ downloadStatus: "pending", title: "torrent" });
    vi.spyOn(failingRepository, "save").mockRejectedValueOnce(new Error("disk unavailable"));
    const failingCommands = new DownloadHistoryCommands(failingRepository, { isEnabled: async () => true }, { publish: vi.fn() });
    await expect(failingCommands.setStatus(1, "failed")).rejects.toThrow("disk unavailable");
  });
});
