// BugShot 服务端安装包：和客户端同一份代码，入口换成 out/main/server-app.js。
// 服务端和客户端分开发版：版本号用 package.json 的 serverVersion（客户端用 version）。
const { serverVersion } = require('./package.json')

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: 'com.hui455.bugshot.server',
  productName: 'BugShot Server',
  extraMetadata: { main: 'out/main/server-app.js', name: 'bugshot-server', version: serverVersion },
  directories: { output: 'release-server', buildResources: 'build' },
  files: ['out/**/*', 'package.json'],
  win: { target: 'nsis', artifactName: 'BugShot-Server-Setup-${version}.${ext}' },
  nsis: { oneClick: false, allowToChangeInstallationDirectory: true },
  mac: {
    target: [
      { target: 'dmg', arch: ['x64', 'arm64'] },
      // 自动更新用 zip
      { target: 'zip', arch: ['x64', 'arm64'] }
    ],
    category: 'public.app-category.developer-tools',
    artifactName: 'BugShot-Server-${version}-${arch}.${ext}'
  },
  linux: { target: 'AppImage', artifactName: 'BugShot-Server-${version}.${ext}' },
  // 自动更新文件叫 server.yml / server-mac.yml，由发布流程上传到 server-v* 的 Release；
  // 服务端窗口里的“检查更新”只看 server-v* 的 Release（src/main/tagged-provider.ts）
  publish: { provider: 'github', owner: 'hui455', repo: 'test-android', releaseType: 'release', channel: 'server' },
  // 发版前由 npm run release-notes:server 从 CHANGELOG-server.md 生成
  releaseInfo: { releaseNotesFile: 'out/release-notes-server.md' }
}
