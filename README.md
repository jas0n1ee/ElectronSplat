# ElectronSplat

[English](README.md) | [简体中文](README_zh.md)

An offline desktop viewer and converter for 3D Gaussian Splatting, built with Electron and PlayCanvas.

## Features

- Offline conversion of foreground and optional background PLY files.
- A sequential conversion queue and a local scene library with covers, renaming, folder access, and deletion.
- First-person navigation with voxel collision and selectable LOD budgets.
- Shared scene folders that can be moved between supported desktop platforms.

## Platforms

- macOS 13+ on Apple silicon (arm64) is available in the current prerelease.
- Windows x64 is available as an unsigned prerelease download. Its current build has not been run or conversion-tested on Windows.
- Linux x64 can be built from source; no Linux download is provided yet.
- Intel Macs are not supported.

Conversion runs in a bundled Node process and requires a GPU supported by Dawn (D3D12, Metal, or Vulkan). Viewing uses WebGPU where the platform offers it and WebGL2 otherwise. On Linux it is WebGL2: Chromium does not enable its Vulkan backend there by default, so WebGPU is unavailable to the renderer. Conversion is unaffected, because it reaches Vulkan directly through Dawn instead of going through Chromium. The application interface is in Simplified Chinese.

## Download and use

Download an archive from [GitHub Releases](https://github.com/jas0n1ee/ElectronSplat/releases). Each release lists its available platforms and important limitations. Prereleases are intended for testing.

1. Verify the archive against the release's `SHA256SUMS.txt`, then extract the ZIP.
2. Open `ElectronSplat.app` on macOS or `Win/ElectronSplat.exe` on Windows.
3. Select a foreground PLY and an optional background PLY, enter a scene name, choose a voxel size, and add the scene to the conversion queue.
4. Open a converted scene from the library. Move with **WASD / QE** and look with the mouse. Saving a cover also saves the starting camera pose.

Keep the app or `Win/` folder beside the shared `scenes/` folder:

```text
ElectronSplat/
├── ElectronSplat.app/  (macOS) or Win/  (Windows)
└── scenes/
```

Copy complete scene folders into `scenes/` to add them to the library. LOD budgets range from 3M to 9M splats. Conversion produces official PlayCanvas streamed LOD/SOG (SH0) and voxel collision data. It halves the splat count for each additional LOD level, targeting a coarsest level below 9M splats, with a minimum of three and a maximum of 16 levels. The level count is recorded in the scene.

The current Windows package is unsigned and has not been run or conversion-tested on Windows.

## Development

Node.js 22.12+ is required. Install dependencies and run the app:

```bash
npm ci
npm start
```

Run checks:

```bash
npm run check
npm test
```

Packaging also uses `zip`, `unzip`, and `tar`. Building macOS packages requires a Mac with Xcode command-line tools installed.

Build and package the required targets:

```bash
npm run build:desktop
node scripts/package-desktop.mjs win32 x64
node scripts/package-desktop.mjs darwin arm64
```

Create the Windows ZIP with `npm run transfer:win`.

ZIPs are written to `desktop-transfer/`. Scene data and generated builds are not committed to Git.

## Issues and contributions

Report bugs and suggest improvements through [GitHub Issues](https://github.com/jas0n1ee/ElectronSplat/issues). For a bug report, include the app version, operating system, GPU, reproduction steps, and, if useful, a diagnostic JSON exported from the app. Review the export for private paths and scene data before sharing.

For substantial changes, open an issue to discuss the approach first. Keep pull requests focused and run `npm run check` and `npm test`. Update both READMEs when changing user-facing documentation.

## License

[MIT](LICENSE) © 2026 Jason Li. See [third-party notices](THIRD_PARTY_NOTICES.md) for dependency licenses.
