/**
 * 客户端产物：把标准 ESM 源码打包成 `window.__ModuleLoader__.load({ id, factory })`
 * 闭包。宿主端 `lib/index.js` 由 tsc 生成，本配置只负责浏览器产物 `lib/client.js`。
 *
 * 共享模块（react / dsh-loader 客户端套件）必须 external：浏览器只有一个 React
 * 实例，且 `@dsh-plugin/dsh-loader/client` 自身就是同格式闭包，静态分析看不到
 * 任何具名导出。其余依赖内联。
 */
import { defineConfig } from 'tsdown';

const CLIENT_EXTERNALS: readonly string[] = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@dsh-plugin/dsh-loader/client',
];

export default defineConfig({
  name: '@dsh-plugin/dsh-mode-builder/client',
  entry: { client: 'src/client/index.tsx' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  dts: false,
  sourcemap: true,
  clean: false,
  external: [...CLIENT_EXTERNALS],
  noExternal: (id: string) => (CLIENT_EXTERNALS.includes(id) ? undefined : true),
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
  },
  outputOptions: {
    entryFileNames: 'client.js',
    banner: 'window.__ModuleLoader__.load({ id: "@dsh-plugin/dsh-mode-builder", factory: (require) => {',
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
    codeSplitting: false,
  },
});
