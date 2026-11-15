// Type surface of icon-pack.mjs for the vitest suite (src/main/icon-pack.test.ts); the script
// itself stays plain .mjs so `npm run make-icon` needs no build step.
export declare const LINUX_ICON_SIZES: number[]
export declare const ICNS_FRAMES: Array<{ type: string; px: number }>
export declare function packIcns(frames: Map<string, Buffer>): Buffer
