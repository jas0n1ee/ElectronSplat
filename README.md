# ElectronSplat

An offline desktop viewer and converter for 3D Gaussian Splatting, built with Electron and PlayCanvas.

## Platforms

- Windows x64
- macOS on Apple silicon (arm64)
- Linux x64

Intel Macs are not supported. Conversion runs in a bundled Node process and needs a GPU that Dawn
can use (D3D12, Metal or Vulkan); viewing needs WebGPU or falls back to WebGL2.

## Usage

1. Extract the release ZIP. On macOS, extract onto a local disk that supports app symlinks, such as APFS.
2. Open `ElectronSplat.exe` (Windows) or `ElectronSplat.app` (macOS).
3. Add a foreground PLY, an optional background PLY, a scene name, and a voxel size. Submit each scene to the conversion queue.
4. Open a scene from the library. Move with **WASD / QE** and look with the mouse. Save a cover to also save the starting camera pose.

Scenes are saved directly to a shared folder:

```text
ElectronSplat/
├── Win/ElectronSplat.exe
├── ElectronSplat.app/
└── scenes/
```

Copy complete scene folders into `scenes/` to add them to the library. LOD budgets range from 3M to 9M splats. Conversion uses official PlayCanvas streamed LOD/SOG (SH0) and voxel collision formats.

Version 0.1.0 is unsigned and its macOS app is not notarized. New macOS release candidates must pass Developer ID signing, notarization, and stapling before publication. Windows builds are unsigned.

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
# Run the following macOS steps on a Mac with a Developer ID identity and notarytool profile.
node scripts/sign-macos.mjs --identity "<Developer ID Application identity>" --profile "<Keychain profile>"
npm run transfer:mac -- arm64 --signed-release
```

Release ZIPs are written to `desktop-transfer/`. Scene data and generated builds are excluded from Git.

## License

[MIT](LICENSE) © 2026 Jason Li. See [third-party notices](THIRD_PARTY_NOTICES.md) for dependency licenses.
