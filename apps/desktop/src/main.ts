import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { app, BrowserWindow, dialog, shell } from 'electron';
import { BackendClient } from './backend-client.js';

app.setName('Flux Agent');
const iconPath = join(app.getAppPath(), 'icon.png');
if (process.env.FLUX_DATA_DIR) {
  const dataDirectory = resolve(process.env.FLUX_DATA_DIR);
  mkdirSync(dataDirectory, { recursive: true });
  app.setPath('userData', dataDirectory);
}
let window: BrowserWindow | undefined;
let origin = '';
let quitting = false;
const backend = new BackendClient(
  () => window,
  () => {
    dialog.showErrorBox('Flux Agent', '后台意外退出，请重新打开应用。已保存的数据会保留。');
    app.quit();
  },
);

function openExternal(url: string): void {
  if (!URL.canParse(url)) return;
  const target = new URL(url);
  if (target.protocol === 'https:' || target.protocol === 'http:') void shell.openExternal(url);
}

async function createWindow(): Promise<void> {
  window = new BrowserWindow({
    title: 'Flux Agent',
    icon: iconPath,
    width: 1440,
    height: 960,
    minWidth: 900,
    minHeight: 640,
    show: false,
    backgroundColor: '#111318',
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
  });
  const current = window;
  current.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: 'deny' };
  });
  current.webContents.on('will-navigate', (event, url) => {
    if (new URL(url).origin === origin) return;
    event.preventDefault();
    openExternal(url);
  });
  current.once('ready-to-show', () => current.show());
  current.once('closed', () => {
    window = undefined;
  });
  await current.loadURL(origin);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!window && origin && !quitting) void createWindow();
    else {
      if (window?.isMinimized()) window.restore();
      window?.focus();
    }
  });
  app.on('activate', () => {
    if (!window && origin && !quitting) void createWindow();
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  app.on('before-quit', (event) => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    void backend.stop().then(
      () => app.quit(),
      () => app.exit(1),
    );
  });
  void app
    .whenReady()
    .then(async () => {
      if (!app.isPackaged) app.dock?.setIcon(iconPath);
      origin = await backend.start(join(app.getAppPath(), 'dist/apps/server/dist/bootstrap/main.js'), {
        ...process.env,
        PORT: '3000',
        FLUX_DATA_DIR: process.env.FLUX_DATA_DIR ?? app.getPath('userData'),
        FLUX_WORKSPACE_DIR: app.getPath('home'),
      });
      if (!quitting) await createWindow();
    })
    .catch((error: unknown) => {
      if (quitting) return;
      console.error('Flux Agent 桌面版启动失败。', error);
      dialog.showErrorBox('Flux Agent', '应用未能启动，请退出后重试。');
      app.quit();
    });
}
