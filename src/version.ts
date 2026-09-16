declare const __APP_VERSION__:string;
// Injected from package.json by the build, shared by all runtime diagnostics.
export const APP_VERSION=__APP_VERSION__;

declare const __APP_BUILD__:string;
export const APP_BUILD=typeof __APP_BUILD__==='string'?__APP_BUILD__:'development';
