# ElectronSplat

[English](README.md) | [简体中文](README_zh.md)

An offline desktop viewer and converter for 3D Gaussian Splatting, built with Electron and PlayCanvas.

## Features

- Offline conversion of foreground and optional background PLY files.
- A sequential conversion queue and a local scene library with covers, renaming, folder access, and deletion.
- First-person navigation with voxel collision and selectable LOD budgets.
- Shared scene folders that can be moved between supported desktop platforms.

## Platforms

- Windows x64 and macOS 13+ on Apple silicon (arm64).
- Linux x64 can be built from source; no Linux binary is currently distributed.
- Intel Macs are not supported.

Conversion runs in a bundled Node process and requires a GPU supported by Dawn (D3D12, Metal, or Vulkan). Viewing uses WebGPU with a WebGL2 fallback. The application interface is in Simplified Chinese.

## Download and use

Download an archive from [GitHub Releases](https://github.com/jas0n1ee/ElectronSplat/releases). Each release lists its available platforms, validation results, and known limitations. Prereleases are intended for testing.

1. Verify the archive against the release's `SHA256SUMS.txt`, then extract the entire archive. On macOS, use a local filesystem that supports symlinks, such as APFS.
2. Open `Win/ElectronSplat.exe` on Windows or `ElectronSplat.app` on macOS.
3. Select a foreground PLY and an optional background PLY, enter a scene name, choose a voxel size, and add the scene to the conversion queue.
4. Open a converted scene from the library. Move with **WASD / QE** and look with the mouse. Saving a cover also saves the starting camera pose.

Keep the app and the shared `scenes/` folder together:

```text
ElectronSplat/
├── Win/ElectronSplat.exe
├── ElectronSplat.app/
└── scenes/
```

Copy complete scene folders into `scenes/` to add them to the library. LOD budgets range from 3M to 9M splats. Conversion produces official PlayCanvas streamed LOD/SOG (SH0) and voxel collision data.

Check the signing and validation status in the notes for the release you download. Windows builds are currently unsigned.

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

Packaging also uses `zip`, `unzip`, and `tar`. Build and sign macOS packages on a Mac with Xcode and its command-line tools installed.

Build and package the required targets:

```bash
npm run build:desktop
node scripts/package-desktop.mjs win32 x64
node scripts/package-desktop.mjs darwin arm64
```

Create the Windows ZIP with `npm run transfer:win`. On a Mac configured with a Developer ID identity and a notarization Keychain profile, sign and verify the macOS package before creating its ZIP:

```bash
node scripts/sign-macos.mjs --identity "<Developer ID Application identity>" --profile "<Keychain profile>"
npm run transfer:mac -- arm64 --signed-release
```

ZIPs are written to `desktop-transfer/`. Scene data and generated builds are not committed to Git.

## Issues and contributions

Report bugs and suggest improvements through [GitHub Issues](https://github.com/jas0n1ee/ElectronSplat/issues). For a bug report, include the app version, operating system, GPU, reproduction steps, and relevant diagnostic logs. Remove private paths and scene data before sharing.

For substantial changes, open an issue to discuss the approach first. Keep pull requests focused and run `npm run check` and `npm test`. Update both READMEs when changing user-facing documentation.

## License

[MIT](LICENSE) © 2026 Jason Li. See [third-party notices](THIRD_PARTY_NOTICES.md) for dependency licenses.
