import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const GOOGLE_FONTS =
  'https://fonts.googleapis.com/css2?family=Lexend:wght@400;600&family=Playpen+Sans:wght@400;600&display=swap';

/** Hosted build: fonts come from Google Fonts instead of bundled files. */
const hostedFonts = () => ({
  name: 'hosted-fonts',
  transformIndexHtml: (html) =>
    html.replace(/^.*rel="icon".*\n/m, '').replace(
      '</head>',
      `  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />\n    <link rel="stylesheet" href="${GOOGLE_FONTS}" />\n  </head>`,
    ),
});

/*
 * Two targets:
 *   npm run dev / npm run build   the local app (any provider, bundled fonts)
 *   npm run build:hosted          a self-contained page for hosting on claude.ai
 *                                 (relative paths, stable file names, dist-hosted/)
 *
 * Optional dev proxy for endpoints that block browser (CORS) requests:
 * put LLM_PROXY_TARGET=https://your-endpoint.example in .env.local, then use
 * "/llm-proxy/v1" as the base URL in Settings. See README.
 */
export default defineConfig(({ mode }) => {
  const hosted = mode === 'hosted';
  const { LLM_PROXY_TARGET: target } = loadEnv(mode, process.cwd(), '');
  return {
    base: './', // relative, so the build works from any folder (GitHub Pages project sites included)
    publicDir: hosted ? false : 'public',
    define: { __HOSTED_BUILD__: JSON.stringify(hosted) },
    plugins: [react(), tailwindcss(), hosted && hostedFonts()],
    build: hosted
      ? {
          outDir: 'dist-hosted',
          rollupOptions: {
            output: { entryFileNames: 'assets/app.js', chunkFileNames: 'assets/[name].js', assetFileNames: 'assets/[name][extname]' },
          },
        }
      : {},
    server: {
      proxy: target
        ? {
            '/llm-proxy': {
              target,
              changeOrigin: true,
              rewrite: (path) => path.replace(/^\/llm-proxy/, ''),
              configure: (proxy) =>
                proxy.on('proxyReq', (req) => {
                  req.removeHeader('origin');
                  req.removeHeader('referer');
                }),
            },
          }
        : undefined,
    },
  };
});
