# ElectronSplat

An offline desktop viewer and converter for 3D Gaussian Splatting, built with Electron and PlayCanvas.

## Platforms

- Windows x64
- macOS on Apple silicon (arm64)

Linux releases are paused. Intel Macs are not supported. Conversion requires WebGPU.

## Usage

1. Extract the release ZIP. On macOS, extract onto a local disk that supports app symlinks, such as APFS.
2. Open `Portable-3DGS-Viewer.exe` (Windows) or `Portable-3DGS-Viewer.app` (macOS).
3. Add a foreground PLY, an optional background PLY, a scene name, and a voxel size. Submit each scene to the conversion queue.
4. Open a scene from the library. Move with **WASD / QE** and look with the mouse. Save a cover to also save the starting camera pose.

Scenes are saved directly to a shared folder:

```text
ElectronSplat/
├── Win/Portable-3DGS-Viewer.exe
├── Portable-3DGS-Viewer.app/
└── scenes/
```

Copy complete scene folders into `scenes/` to add them to the library. LOD budgets range from 3M to 9M splats. Conversion uses official PlayCanvas streamed LOD/SOG (SH0) and voxel collision formats.

Release binaries are unsigned; macOS builds are not notarized.

## Development

Node.js 22.12+ is required.

```bash
npm ci
npm start
npm run check
npm test
```

Build and package:

```bash
npm run build:desktop
node scripts/package-desktop.mjs win32 x64
node scripts/package-desktop.mjs darwin arm64
npm run transfer:win
npm run transfer:mac
```

Release ZIPs are written to `desktop-transfer/`. Scene data and generated builds are excluded from Git.

## License

[MIT](LICENSE) © 2026 Jason Li. See [third-party notices](THIRD_PARTY_NOTICES.md) for dependency licenses.
