import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import pkg from './package.json'

export default defineConfig({
  // 主进程依赖全部打进 out/main，安装包里不再带 node_modules
  main: {
    resolve: { alias: { '@shared': resolve('src/shared') } },
    // 服务端有自己的版本号，和客户端（version）分开发版
    define: { __SERVER_VERSION__: JSON.stringify(pkg.serverVersion) },
    // index 是测试人员用的客户端，server-app 是带窗口的服务端
    build: { rollupOptions: { input: { index: resolve('src/main/index.ts'), 'server-app': resolve('src/main/server-app.ts') } } }
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    resolve: { alias: { '@shared': resolve('src/shared') } },
    plugins: [react()]
  }
})
