import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  bootstrapApp: vi.fn(),
  disposeActiveApp: vi.fn(),
  onCloseRequested: vi.fn(),
  destroy: vi.fn(),
}));

vi.mock("./bootstrap.ts", () => ({ bootstrapApp: mocks.bootstrapApp, disposeActiveApp: mocks.disposeActiveApp }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ onCloseRequested: mocks.onCloseRequested, destroy: mocks.destroy }),
}));

beforeEach(() => {
  vi.resetModules();
  mocks.bootstrapApp.mockReset();
  mocks.disposeActiveApp.mockReset().mockResolvedValue(undefined);
  mocks.onCloseRequested.mockReset().mockResolvedValue(() => undefined);
  mocks.destroy.mockReset().mockResolvedValue(undefined);
});

describe("桌面窗口关闭", () => {
  it("等待正在运行的释放任务完成后才销毁窗口", async () => {
    let finishDispose!: () => void;
    const disposing = new Promise<void>((resolve) => {
      finishDispose = resolve;
    });
    const dispose = vi.fn(() => disposing);
    mocks.disposeActiveApp.mockImplementation(dispose);
    mocks.bootstrapApp.mockResolvedValue({ dispose });
    await import("./main.ts");

    const event = { preventDefault: vi.fn() };
    const onClose = mocks.onCloseRequested.mock.calls[0][0] as (closeEvent: {
      preventDefault(): void;
    }) => Promise<void>;
    const closing = onClose(event);
    await Promise.resolve();
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
    expect(mocks.destroy).not.toHaveBeenCalled();

    finishDispose();
    await closing;
    expect(mocks.destroy).toHaveBeenCalledOnce();
  });

  it("释放失败时保留窗口且不输出异常原文", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.bootstrapApp.mockResolvedValue({ dispose: () => Promise.reject(new Error("Bearer sensitive")) });
    mocks.disposeActiveApp.mockRejectedValue(new Error("Bearer sensitive"));
    await import("./main.ts");

    const onClose = mocks.onCloseRequested.mock.calls[0][0] as (event: { preventDefault(): void }) => Promise<void>;
    await onClose({ preventDefault: vi.fn() });
    expect(mocks.destroy).not.toHaveBeenCalled();
    expect(JSON.stringify(log.mock.calls)).not.toContain("sensitive");
    log.mockRestore();
  });
});
