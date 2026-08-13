/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import { devtools } from '@tanstack/devtools-vite';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import viteReact from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { nitro } from 'nitro/vite';
import path from 'node:path';
import { storybookTest } from '@storybook/addon-vitest/vitest-plugin';
import { playwright } from '@vitest/browser-playwright';
const dirname = import.meta.dirname;

// More info at: https://storybook.js.org/docs/next/writing-tests/integrations/vitest-addon
const config = defineConfig({
  resolve: {
    tsconfigPaths: true
  },
  // Client assets are emitted under /admin/ so every URL the node owns sits
  // beneath one prefix. On a custom domain only that prefix is routed to the
  // node — the rest of the hostname belongs to the operator's own website, and
  // a bare /assets/ would collide with theirs.
  build: {
    assetsDir: 'admin/assets'
  },
  plugins: [devtools(), nitro({
    // Each node ships as a Workers-for-Platforms user Worker. The preset emits
    // multiple ES modules (inlineDynamicImports is false), which the upload has
    // to send as separate parts.
    preset: 'cloudflare-module',
    compatibilityDate: '2025-07-13',
    rollupConfig: {
      external: [/^@sentry\//]
    }
  }), tailwindcss(), tanstackStart(), viteReact()],
  test: {
    projects: [{
      extends: true,
      plugins: [
      // The plugin will run tests for the stories defined in your Storybook config
      // See options at: https://storybook.js.org/docs/next/writing-tests/integrations/vitest-addon#storybooktest
      storybookTest({
        configDir: path.join(dirname, '.storybook')
      })],
      test: {
        name: 'storybook',
        browser: {
          enabled: true,
          headless: true,
          provider: playwright({}),
          instances: [{
            browser: 'chromium'
          }]
        }
      }
    }]
  }
});
export default config;