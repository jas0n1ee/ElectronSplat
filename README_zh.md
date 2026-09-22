# ElectronSplat

[English](README.md) | [简体中文](README_zh.md)

基于 Electron 和 PlayCanvas 的离线 3D Gaussian Splatting 桌面查看与转换工具。

## 功能

- 离线转换前景 PLY 和可选的背景 PLY。
- 顺序执行的转换队列，以及支持首图、重命名、打开文件夹和删除的本地场景库。
- 支持 voxel collision 和可选 LOD budget 的第一人称漫游。
- 可在支持的桌面平台之间搬移的共享场景文件夹。

## 平台

- Windows x64、macOS 13+ 的 Apple silicon（arm64）设备。
- Linux x64 可从源码构建，目前不提供 Linux 二进制下载。
- 不支持 Intel Mac。

转换在内置 Node 进程中执行，需要 Dawn 支持的 GPU（D3D12、Metal 或 Vulkan）。场景查看使用 WebGPU，并可回退至 WebGL2。应用界面为简体中文。

## 下载与使用

从 [GitHub Releases](https://github.com/jas0n1ee/ElectronSplat/releases) 下载压缩包。各版本说明列出可用平台、验证结果和已知限制；prerelease 用于测试。

1. 根据该版本的 `SHA256SUMS.txt` 校验压缩包，然后完整解压。macOS 请使用 APFS 等支持 symlink 的本地文件系统。
2. Windows 打开 `Win/ElectronSplat.exe`，macOS 打开 `ElectronSplat.app`。
3. 选择前景 PLY 和可选的背景 PLY，填写场景名称、选择 voxel 尺寸，再加入转换队列。
4. 从场景库打开转换后的场景。使用 **WASD / QE** 移动，鼠标控制视角；保存首图也会保存起始 camera pose。

应用和共享的 `scenes/` 文件夹保持以下相邻关系：

```text
ElectronSplat/
├── Win/ElectronSplat.exe
├── ElectronSplat.app/
└── scenes/
```

将完整场景文件夹复制到 `scenes/` 即可加入场景库。LOD budget 为 300 万至 900 万 splats。转换生成 PlayCanvas 官方 streamed LOD/SOG（SH0）和 voxel collision 数据。

安装前请查看所下载版本的 Release Notes，确认其签名与验证状态。Windows 包目前未签名。

## 开发

需要 Node.js 22.12+。安装依赖并启动应用：

```bash
npm ci
npm start
```

运行检查：

```bash
npm run check
npm test
```

打包还需要 `zip`、`unzip` 和 `tar`。macOS 包的构建和签名应在安装了 Xcode 及其 command-line tools 的 Mac 上执行。

构建并打包需要的平台：

```bash
npm run build:desktop
node scripts/package-desktop.mjs win32 x64
node scripts/package-desktop.mjs darwin arm64
```

使用 `npm run transfer:win` 生成 Windows ZIP。在配置了 Developer ID identity 和 notarization Keychain profile 的 Mac 上，先签名并验证 macOS 包，再生成 ZIP：

```bash
node scripts/sign-macos.mjs --identity "<Developer ID Application identity>" --profile "<Keychain profile>"
npm run transfer:mac -- arm64 --signed-release
```

ZIP 输出到 `desktop-transfer/`。场景数据和构建产物不提交到 Git。

## 问题反馈与贡献

通过 [GitHub Issues](https://github.com/jas0n1ee/ElectronSplat/issues) 报告问题或提出改进建议。报告 bug 时请提供应用版本、操作系统、GPU、复现步骤和相关 diagnostic logs；分享前移除私有路径和场景数据。

较大的改动请先开 issue 讨论方案。Pull request 应聚焦具体问题，并运行 `npm run check` 和 `npm test`。修改用户文档时，请同步更新两个 README。

## License

[MIT](LICENSE) © 2026 Jason Li。依赖许可证见 [third-party notices](THIRD_PARTY_NOTICES.md)。
