import type { AxiosInstance } from "axios";
export interface DownloaderDependencies {
  http: AxiosInstance;
  torrentHttp: AxiosInstance;
  openWebSocket(url: string): WebSocket;
}
