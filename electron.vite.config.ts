import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { excalidrawAssetsPlugin } from './scripts/excalidraw-assets-plugin'

export default defineConfig({
  main: {
    // node-pty is a native module; keep it external so it is required from node_modules at runtime.
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared')
      }
    },
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts') },
        // 'electron' is a devDependency, so externalizeDepsPlugin (which reads
        // dependencies) does not externalize it — the npm wrapper at
        // node_modules/electron/index.js would get bundled in, making the app
        // try to download Electron at runtime. node-pty is a native module
        // whose internal require() calls use relative paths that break when
        // bundled. List both explicitly.
        external: ['electron', /^node-pty/, 'node-pty'],
        output: {
          // Force CJS output (.js) — electron-vite v5 defaults to ESM (.mjs), but
          // asar-packaged Electron apps need CJS for the main process entry point.
          format: 'cjs',
          entryFileNames: '[name].js'
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared')
      }
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts'),
          // Tiny HUD-only preload for the macOS Notch HUD window (src/main/notch-hud.ts).
          hud: resolve(__dirname, 'src/preload/hud.ts'),
          // The project-secret paste window's own preload (src/main/secret-entry-window.ts).
          'secret-entry': resolve(__dirname, 'src/preload/secret-entry.ts')
        },
        external: ['electron'],
        output: {
          // Same CJS requirement for the preload script inside asar.
          format: 'cjs',
          entryFileNames: '[name].js'
        }
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    resolve: {
      alias: {
        '@renderer': resolve(__dirname, 'src/renderer'),
        '@shared': resolve(__dirname, 'src/shared'),
        // The whiteboard's Excalidraw would otherwise bundle all of mermaid (~7.3 MB) for its
        // "text to diagram" tool. See the stub's header.
        '@excalidraw/mermaid-to-excalidraw': resolve(__dirname, 'src/renderer/whiteboard/mermaid-stub.ts')
      }
    },
    // excalidrawAssetsPlugin: the whiteboard node's fonts, served offline (see the plugin's doc).
    plugins: [react(), tailwindcss(), excalidrawAssetsPlugin(__dirname)],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
          // Second renderer entry: the macOS Notch HUD overlay window (src/main/notch-hud.ts).
          hud: resolve(__dirname, 'src/renderer/hud.html'),
          // Third entry: the window a person pastes a project secret into (no app code in it).
          'secret-entry': resolve(__dirname, 'src/renderer/secret-entry.html')
        }
      }
    }
  }
})
