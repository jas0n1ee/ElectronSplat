# Application icon

`source.png` is the original artwork. `provenance.json` records its dimensions and SHA-256.

The derived assets preserve the full canvas and transparency: `app.png` (1024px), `app.ico` (16–256px), and `app.icns` (up to 1024px).

Builds use the committed assets. To regenerate with the optional Linux development helper:

```bash
npm run icons -- assets/icons/source.png
```

`PORTABLE_ICON_EXECUTABLE` can select an existing Electron executable. The helper uses Electron `nativeImage` and an isolated temporary profile.
