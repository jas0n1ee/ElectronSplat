# SuperSplat Viewer collision runtime

Official MIT source: https://github.com/playcanvas/supersplat-viewer/tree/96f62515b99a28a20579041a656f7b1911c2964c/src

Pinned commit: 96f62515b99a28a20579041a656f7b1911c2964c. Copied collision/collision.ts, collision/voxel-collision.ts and cameras/sphere-mover.ts. Only modification: SphereMover imports the collision interface directly instead of the upstream barrel. Collision algorithms are unchanged. LICENSE is included in application third-party licenses.
