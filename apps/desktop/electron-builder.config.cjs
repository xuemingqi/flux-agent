const { join } = require('node:path');
const { devDependencies } = require('./package.json');

module.exports = {
  appId: 'com.yonyeyy.flux-agent',
  productName: 'Flux Agent',
  electronVersion: devDependencies.electron,
  directories: { app: join(__dirname, 'dist/app'), output: join(__dirname, 'release') },
  files: ['main.cjs', 'icon.png', 'dist/**/*'],
  asar: true,
  asarUnpack: ['node_modules/better-sqlite3/**/*'],
  artifactName: 'Flux-Agent-${version}-${os}-${arch}.${ext}',
  mac: {
    icon: join(__dirname, 'resources/icon.icns'),
    category: 'public.app-category.developer-tools',
    target: ['dmg', 'zip'],
  },
  win: { icon: join(__dirname, 'resources/icon.ico'), target: ['nsis'] },
  nsis: { oneClick: false, allowToChangeInstallationDirectory: true, createDesktopShortcut: true },
  publish: null,
};
