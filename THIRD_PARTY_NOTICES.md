# Third-party notices

ElectronSplat is licensed under the [MIT License](LICENSE). Third-party components retain their own copyrights and licenses.

| Component | Version / source | License |
| --- | --- | --- |
| [PlayCanvas Engine](https://github.com/playcanvas/engine) | 2.22.2 | MIT |
| [SplatTransform](https://github.com/playcanvas/splat-transform) | 3.4.2 | MIT |
| [SuperSplat Viewer](https://github.com/playcanvas/supersplat-viewer) | Collision sources at `96f62515b99a28a20579041a656f7b1911c2964c`; bundled viewer 1.31.2 | MIT |
| [SPZ](https://github.com/adobe/spz) | @adobe/spz 0.2.3 | MIT text supplied in the package's LICENSE |
| [pathe](https://github.com/unjs/pathe) | 2.0.3, bundled by SplatTransform | MIT, including Node.js attribution |
| [fzstd](https://github.com/101arrowz/fzstd) | 0.1.1, bundled by SplatTransform | MIT |
| [libwebp / libsharpyuv](https://github.com/webmproject/libwebp) | WebP WASM supplied by SplatTransform | BSD-3-Clause, patent grant included |
| [zlib](https://github.com/madler/zlib) | SPZ WASM dependency | Zlib |
| [Zstandard](https://github.com/facebook/zstd) | SPZ WASM dependency | BSD-3-Clause |
| [Emscripten](https://github.com/emscripten-core/emscripten) and [musl](https://musl.libc.org/) | WASM runtime notices | MIT / University of Illinois and musl component notices |
| [Electron](https://github.com/electron/electron) | 44.3.0 | MIT; Chromium and other runtime notices supplied separately |

`@adobe/spz` declares ISC in its npm metadata, but its distributed LICENSE contains the Niantic MIT grant; the distributed text is preserved verbatim. The prebuilt WASM files do not identify all underlying compiler/library revisions. Their upstream license texts are included without claiming a reproducible WASM toolchain.

Source copies of supplemental notices are in `vendor/licenses/`; the collision source provenance is in `vendor/supersplat-viewer/README.md`. Package licenses are read from the exact installed dependencies during the build. Missing required notices stop packaging.

The release includes full license texts in `Win/licenses/` (Windows) or `Portable-3DGS-Viewer.app/Contents/Resources/licenses/` (macOS):

- `LICENSE`: ElectronSplat.
- `THIRD-PARTY-LICENSES.txt`: application libraries and WASM notices.
- `ELECTRON-LICENSE.txt`: Electron.
- `LICENSES.chromium.html`: notices delivered with that platform's Electron runtime.

Build and test tools remain development dependencies and are not bundled into the application. User scene data is not licensed by this project.
