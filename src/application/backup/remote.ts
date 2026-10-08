import type { IBackupConfig, IBackupData, IBackupFileInfo } from "~/packages/backupServer/type.ts";
export interface RemoteBackupClient {
  setEncryptionKey(key: string): void;
  list(): Promise<IBackupFileInfo[]>;
  addFile(filename: string, data: IBackupData): Promise<boolean>;
  getFile(path: string): Promise<IBackupData>;
  deleteFile(path: string): Promise<boolean>;
}
export class RemoteBackupService {
  constructor(
    private readonly ports: {
      config(id: string): Promise<IBackupConfig | undefined>;
      create(config: IBackupConfig): Promise<RemoteBackupClient>;
      recordSuccess(id: string): Promise<void>;
    },
  ) {}
  async client(id: string): Promise<RemoteBackupClient> {
    const config = await this.ports.config(id);
    if (!config) throw new Error("BACKUP_SERVER_UNAVAILABLE");
    return this.ports.create(config);
  }
  async export(id: string, filename: string, data: IBackupData, encryptionKey: string): Promise<boolean> {
    const client = await this.client(id);
    client.setEncryptionKey(encryptionKey);
    const success = await client.addFile(filename, data);
    if (success) await this.ports.recordSuccess(id);
    return success;
  }
  async confirm(id: string, filename: string): Promise<boolean> {
    if (!(await (await this.client(id)).list()).some((file) => file.filename === filename)) return false;
    await this.ports.recordSuccess(id);
    return true;
  }
  async list(id: string): Promise<IBackupFileInfo[]> {
    return (await this.client(id)).list();
  }
  async remove(id: string, path: string): Promise<boolean> {
    return (await this.client(id)).deleteFile(path);
  }
  async read(id: string, path: string, encryptionKey: string): Promise<IBackupData> {
    const client = await this.client(id);
    client.setEncryptionKey(encryptionKey);
    return client.getFile(path);
  }
}
