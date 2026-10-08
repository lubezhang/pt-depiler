import type { CAddTorrentOptions, CAddTorrentResult } from "~/packages/downloader/types.ts";

export interface DownloadSubmissionPorts {
  getConfig(id: string): Promise<{ id?: string; enabled?: boolean } | undefined>;
  getClient(
    id: string,
  ): Promise<{ addTorrent(url: string, options: Partial<CAddTorrentOptions>): Promise<CAddTorrentResult> } | null>;
}
export class DownloadSubmission {
  constructor(private readonly ports: DownloadSubmissionPorts) {}
  async execute(id: string, url: string, options: Partial<CAddTorrentOptions>): Promise<CAddTorrentResult> {
    const config = await this.ports.getConfig(id);
    if (!config?.id || !config.enabled) throw new Error("DOWNLOADER_UNAVAILABLE");
    const client = await this.ports.getClient(id);
    if (!client) throw new Error("DOWNLOADER_UNAVAILABLE");
    return client.addTorrent(url, options);
  }
}
