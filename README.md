# PT-depiler

PT-depiler 是一个基于 Tauri 2、Vue 3 和 TypeScript 构建的 PT 站点桌面管理工具。它聚合多个 PT 站点的搜索与账号数据，并可将种子发送至已配置的下载器。

## 功能

- 支持 NexusPHP、Unit3D、Gazelle 等多种 PT 站点类型
- 跨站点聚合搜索、筛选种子并批量发送下载任务
- 集成 qBittorrent、Transmission、Deluge、ruTorrent、Aria2 和 Synology Download Station 等下载器
- 展示站点用户信息、数据统计和历史记录
- 支持站点登录与 Cookie 同步；敏感数据加密保存，密钥交由操作系统安全存储管理
- 支持 WebDAV、Gist、CookieCloud、Google Drive、Dropbox、S3 等备份与同步服务

## 技术栈

- 桌面端：Tauri 2 与 Rust
- 前端：Vue 3、TypeScript、Vite、Vuetify 与 Pinia
- 包管理器：pnpm

## 开发环境

请先安装以下工具：

- Git
- Node.js 23.7 或更高版本
- pnpm 10.14 或更高版本
- Rust 工具链，以及 Tauri 在对应操作系统上的构建依赖

macOS 下还需要可用的 Xcode Command Line Tools。其他系统的 Tauri 前置依赖请参阅 [Tauri 官方文档](https://v2.tauri.app/start/prerequisites/)。

## 本地开发

```bash
git clone https://github.com/lubezhang/pt-depiler.git
cd pt-depiler
pnpm install
pnpm tauri dev
```

`pnpm tauri dev` 会启动 Vite 开发服务器并打开桌面应用。

## 常用命令

```bash
# 启动前端开发服务器
pnpm dev

# 运行桌面应用开发模式
pnpm tauri dev

# 类型检查
pnpm check

# 运行单元测试
pnpm test

# 构建前端资源
pnpm build:dist

# 构建桌面应用安装包
pnpm tauri build

# 执行格式、类型、测试及 Rust 构建校验
pnpm verify:desktop
```

## 设计文档

- [桌面端架构优化设计](docs/2026-09-12-桌面端架构优化设计.md)
- [Tauri 网络与认证层执行计划](docs/2026-09-11-Tauri网络与认证层执行计划.md)

## 贡献

提交问题或改进建议前，请先确认没有重复 Issue。涉及站点适配时，请不要在 Issue、日志或截图中泄露 Cookie、密钥、Passkey 或其他账号凭据。

## 许可证

本项目采用 [MIT License](LICENSE) 发布。
