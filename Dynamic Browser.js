const { app, BrowserWindow, screen, ipcMain, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const url = require('url');
const activeWin = require('active-win');
const { uIOhook } = require('uiohook-napi');

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
}

let mainWindow;
let tray = null;
let notificationWindow = null;
let notificationTimeout = null;
let isExpanded = false;
let currentAnimation = null;
let fullscreenActive = false;
let dockPosition = 'center';
let isQuitting = false;
let previousActiveWindow = null;
let currentDisplay = null;
let isAnimating = false;
let notificationsEnabled = true;

const configPath = path.join(app.getPath('userData'), 'dock-position.json');
const settingsPath = path.join(app.getPath('userData'), 'app-settings.json');
let appSettings = { runAtStartup: false, hoverToOpen: false, savedLinks: [], startupAnimationEnabled: true, autoUpdateEnabled: false, notificationsEnabled: true };
const COLLAPSED_WIDTH = 180;
const COLLAPSED_HEIGHT = 36;
const EXPANDED_WIDTH = 800;
const EXPANDED_HEIGHT = 520;
const NOTIFICATION_WIDTH = 320;
const NOTIFICATION_HEIGHT = 56;

function loadDockPosition() {
  try {
    if (fs.existsSync(configPath)) {
      const data = fs.readFileSync(configPath, 'utf-8');
      const config = JSON.parse(data);
      if (config.position && ['left', 'center', 'right'].includes(config.position)) {
        dockPosition = config.position;
      }
    }
  } catch (e) {
    dockPosition = 'center';
  }
}

function saveDockPosition() {
  try {
    fs.writeFileSync(configPath, JSON.stringify({ position: dockPosition }), 'utf-8');
  } catch (e) {}
}

function loadSettings() {
  try {
    if (fs.existsSync(settingsPath)) {
      const data = fs.readFileSync(settingsPath, 'utf-8');
      appSettings = JSON.parse(data);
      if (typeof appSettings.runAtStartup !== 'boolean') appSettings.runAtStartup = false;
      if (typeof appSettings.hoverToOpen !== 'boolean') appSettings.hoverToOpen = false;
      if (typeof appSettings.startupAnimationEnabled !== 'boolean') appSettings.startupAnimationEnabled = true;
      if (typeof appSettings.autoUpdateEnabled !== 'boolean') appSettings.autoUpdateEnabled = false;
      if (typeof appSettings.notificationsEnabled !== 'boolean') appSettings.notificationsEnabled = true;
      if (!Array.isArray(appSettings.savedLinks)) appSettings.savedLinks = [];
      appSettings.savedLinks = appSettings.savedLinks.map(item => {
        if (typeof item === 'string') {
          const hostname = (() => { try { return new URL(item).hostname; } catch(e) { return item; } })();
          return { url: item, title: hostname, favicon: 'https://www.google.com/s2/favicons?domain=' + hostname };
        }
        return item;
      });
    }
  } catch (e) {
    appSettings = { runAtStartup: false, hoverToOpen: false, savedLinks: [], startupAnimationEnabled: true, autoUpdateEnabled: false, notificationsEnabled: true };
  }
  notificationsEnabled = appSettings.notificationsEnabled;
}

function saveSettings() {
  try {
    fs.writeFileSync(settingsPath, JSON.stringify(appSettings), 'utf-8');
  } catch (e) {}
}

function setAutoLaunch(value) {
  app.setLoginItemSettings({
    openAtLogin: value,
    path: app.getPath('exe')
  });
  appSettings.runAtStartup = value;
  saveSettings();
}

function setHoverToOpen(value) {
  appSettings.hoverToOpen = value;
  saveSettings();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('hover-mode-changed', value);
  }
}

function setNotificationsEnabled(value) {
  appSettings.notificationsEnabled = value;
  notificationsEnabled = value;
  saveSettings();
}

function getCurrentDisplayForWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return screen.getPrimaryDisplay();
  const bounds = mainWindow.getBounds();
  return screen.getDisplayMatching(bounds);
}

function updateCurrentDisplay() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    currentDisplay = getCurrentDisplayForWindow();
  } else {
    currentDisplay = screen.getPrimaryDisplay();
  }
}

function getXForDock(width, position, display) {
  const screenWidth = display.workAreaSize.width;
  if (position === 'left') return display.bounds.x;
  if (position === 'right') return display.bounds.x + screenWidth - width;
  return display.bounds.x + Math.round((screenWidth - width) / 2);
}

function destroyNotification(animate = false) {
  if (notificationTimeout) {
    clearTimeout(notificationTimeout);
    notificationTimeout = null;
  }
  if (notificationWindow && !notificationWindow.isDestroyed()) {
    if (animate) {
      try {
        notificationWindow.webContents.executeJavaScript(`
          const el = document.querySelector('.notification');
          if (el) el.classList.add('closing');
          setTimeout(() => { require('electron').ipcRenderer.send('close-notification'); }, 300);
        `);
      } catch (e) {
        notificationWindow.destroy();
      }
    } else {
      notificationWindow.destroy();
    }
  }
  notificationWindow = null;
}

function showNotification(message) {
  if (!notificationsEnabled) return;
  if (notificationWindow && !notificationWindow.isDestroyed()) {
    destroyNotification();
  }
  const display = currentDisplay || screen.getPrimaryDisplay();
  const x = display.workArea.x + display.workArea.width - NOTIFICATION_WIDTH - 16;
  const y = display.workArea.y + display.workArea.height - NOTIFICATION_HEIGHT - 16;

  notificationWindow = new BrowserWindow({
    x, y,
    width: NOTIFICATION_WIDTH,
    height: NOTIFICATION_HEIGHT,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    minimizable: false,
    shadow: false,
    thickFrame: false,
    backgroundColor: '#00000000',
    show: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  });
  notificationWindow.setAlwaysOnTop(true, 'screen-saver');
  notificationWindow.setVisibleOnAllWorkspaces(true);
  notificationWindow.setIgnoreMouseEvents(false);
  notificationWindow.setHasShadow(false);

  const notifSoundPath = 'file:///' + path.join(__dirname, 'Notification.wav').replace(/\\/g, '/');

  const notifHtml = `
  <!DOCTYPE html>
  <html style="margin:0;padding:0;background:transparent;">
  <head>
    <meta charset="UTF-8">
    <style>
      * { margin:0; padding:0; box-sizing:border-box; user-select:none; }
      html, body { width:100%; height:100%; background:transparent; overflow:hidden; font-family:'Inter', sans-serif; }
      body { display:flex; align-items:center; justify-content:flex-end; }
      .notification {
        background: #1a1a1a;
        border-radius: 12px;
        padding: 12px 20px;
        color: white;
        font-size: 14px;
        font-weight: 500;
        border: 0.5px solid #333333;
        display: flex;
        align-items: center;
        opacity: 0;
        transform: translateX(100%);
        animation: slideInRight 0.35s cubic-bezier(0.2, 0.9, 0.4, 1.1) forwards;
        box-shadow: 0 4px 12px rgba(0,0,0,0.5);
        max-width: 100%;
      }
      .notification.closing {
        animation: slideOutRight 0.25s ease forwards;
      }
      @keyframes slideInRight {
        to { opacity: 1; transform: translateX(0); }
      }
      @keyframes slideOutRight {
        to { opacity: 0; transform: translateX(100%); }
      }
    </style>
  </head>
  <body>
    <audio id="notifSound" src="${notifSoundPath}" preload="auto"></audio>
    <div class="notification">${message}</div>
    <script>
      const { ipcRenderer } = require('electron');
      const notifEl = document.querySelector('.notification');
      const notifSound = document.getElementById('notifSound');
      try { notifSound.play().catch(() => {}); } catch(e) {}
      notifEl.addEventListener('click', () => {
        ipcRenderer.send('close-notification-animated');
      });
    </script>
  </body>
  </html>
  `;
  notificationWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(notifHtml)}`);
  notificationWindow.once('ready-to-show', () => {
    notificationWindow.show();
  });
  notificationTimeout = setTimeout(() => destroyNotification(true), 3000);
}

function performUpdate() {
  return new Promise((resolve) => {
    const updateUrl = 'https://raw.githubusercontent.com/Shon-Lua/Dynamic-Browser/refs/heads/main/Dynamic%20Browser.js';
    const targetPath = path.join(__dirname, 'index.js');
    let localContent = '';
    try {
      if (fs.existsSync(targetPath)) {
        localContent = fs.readFileSync(targetPath, 'utf-8');
      }
    } catch (e) {}
    https.get(updateUrl, (res) => {
      if (res.statusCode !== 200) {
        resolve();
        return;
      }
      let remoteData = '';
      res.on('data', chunk => remoteData += chunk);
      res.on('end', () => {
        if (remoteData.trim() === localContent.trim()) {
          showNotification('Обновлений нет');
          resolve();
          return;
        }
        try {
          fs.writeFileSync(targetPath, remoteData, 'utf-8');
        } catch (err) {
          resolve();
          return;
        }
        app.relaunch();
        app.exit();
      });
    }).on('error', () => {
      resolve();
    });
  });
}

function createWindow(wallpaperPath) {
  updateCurrentDisplay();
  const windowWidth = COLLAPSED_WIDTH;
  const windowHeight = COLLAPSED_HEIGHT;
  const x = getXForDock(windowWidth, dockPosition, currentDisplay);
  const y = currentDisplay.bounds.y;

  mainWindow = new BrowserWindow({
    width: windowWidth,
    height: windowHeight,
    x: x,
    y: y,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    minimizable: false,
    shadow: false,
    backgroundColor: '#00000000',
    show: false,
    icon: nativeImage.createFromPath(path.join(__dirname, 'Logo.ico')),
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      webviewTag: true,
      nativeWindowOpen: false,
      webSecurity: false
    }
  });

  mainWindow.setAlwaysOnTop(true, 'screen-saver');
  mainWindow.setVisibleOnAllWorkspaces(true);

  mainWindow.on('minimize', () => {
    mainWindow.restore();
  });

  let lastOpenedUrl = null;

  const isAuthUrl = (url) => {
    return url.includes('accounts.google.com') ||
           url.includes('login.microsoftonline.com') ||
           url.includes('oauth') ||
           url.includes('signin') ||
           url.includes('authorize') ||
           url.includes('login?') ||
           url.includes('sso');
  };

  mainWindow.webContents.on('did-attach-webview', (event, webContents) => {
    webContents.setWindowOpenHandler(({ url }) => {
      if (!url || url === 'about:blank' || url.startsWith('javascript:')) {
        return { action: 'deny' };
      }
      if (isAuthUrl(url)) {
        mainWindow.webContents.send('open-new-tab', url);
        return { action: 'deny' };
      }
      if (lastOpenedUrl === url) {
        return { action: 'deny' };
      }
      lastOpenedUrl = url;
      mainWindow.webContents.send('open-new-tab', url);
      return { action: 'deny' };
    });
  });

  let logoDataUri = '';
  try {
    const logoBuffer = fs.readFileSync(path.join(__dirname, 'Logo.ico'));
    logoDataUri = 'data:image/x-icon;base64,' + logoBuffer.toString('base64');
  } catch (e) {}

  const startupAnimFlag = appSettings.startupAnimationEnabled;
  const clickSoundPath = 'file:///' + path.join(__dirname, 'Click.wav').replace(/\\/g, '/');
  const startupSoundPath = 'file:///' + path.join(__dirname, 'StartUp.wav').replace(/\\/g, '/');
  const questionSoundPath = 'file:///' + path.join(__dirname, 'Question.wav').replace(/\\/g, '/');
  const wallpaperUrl = wallpaperPath ? url.pathToFileURL(wallpaperPath).href : '';

  const html = `
  <!DOCTYPE html>
  <html style="margin:0;padding:0;background:transparent;">
  <head>
    <meta charset="UTF-8">
    <style>
      @import url('https://fonts.googleapis.com/css2?family=Inter:opsz,wght@14..32,400;14..32,500;14..32,600;14..32,700&display=swap');
      * { margin: 0; padding: 0; box-sizing: border-box; user-select: none; }
      html, body { width: 100%; height: 100%; background: transparent; overflow: hidden; }
      body { display: flex; align-items: center; justify-content: center; cursor: pointer; font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; position: relative; overflow-x: hidden; }
      .dynamic-island {
        width: 100%; height: 100%;
        background: #000000;
        border-top-left-radius: 0;
        border-top-right-radius: 0;
        border-bottom-left-radius: 12px;
        border-bottom-right-radius: 12px;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: background 0.2s ease, border-radius 0.2s ease;
        overflow: hidden;
        position: relative;
        transform: scale(0.95);
        opacity: 0;
        animation: fadeInScale 0.35s cubic-bezier(0.2, 0.9, 0.4, 1.1) forwards;
      }
      @keyframes fadeInScale {
        0% { opacity: 0; transform: scale(0.92); }
        100% { opacity: 1; transform: scale(1); }
      }
      .dynamic-island:not(.home-active):hover {
        background: #111111;
      }
      .dynamic-island.home-active {
        background-color: #000000;
      }
      .dynamic-island.expanded {
        border-bottom-left-radius: 20px;
        border-bottom-right-radius: 20px;
      }
      .collapsed-content {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 10px;
        width: 100%;
        height: 100%;
        color: white;
        font-size: 12px;
        font-weight: 600;
        padding: 0 12px;
      }
      .collapsed-time {
        white-space: nowrap;
        opacity: 0;
        transition: opacity 0.5s ease;
        font-size: 15px;
        font-weight: 700;
        letter-spacing: 0.5px;
      }
      .collapsed-time.visible {
        opacity: 1;
      }
      .browser-container {
        width: 100%; height: 100%; opacity: 0; transition: opacity 0.2s ease;
        display: none; flex-direction: column; min-width: 0; min-height: 0; position: relative;
        overflow: hidden;
      }
      .expanded .browser-container { display: flex; opacity: 1; }
      .expanded .collapsed-content { display: none; }
      .tabs-bar {
        display: flex; align-items: stretch; padding: 6px 8px 0 8px; background: #111111;
        border-bottom: 0.5px solid #222222; flex-shrink: 0; min-height: 32px;
        overflow-x: auto; overflow-y: hidden;
      }
      .tabs-scroll {
        flex: 1 1 auto; overflow-x: auto; display: flex; gap: 4px; min-width: 0;
      }
      .tabs-scroll::-webkit-scrollbar { height: 4px; }
      .tabs-scroll::-webkit-scrollbar-track { background: transparent; }
      .tabs-scroll::-webkit-scrollbar-thumb { background: #444; border-radius: 2px; }
      .tabs-scroll::-webkit-scrollbar-thumb:hover { background: #555; }
      .add-tab {
        background: #1a1a1a; border-radius: 18px; width: 28px; min-width: 28px; height: 28px;
        display: flex; align-items: center; justify-content: center; cursor: pointer;
        font-size: 16px; font-weight: bold; color: white; border: 0.5px solid #333333;
        transition: all 0.2s ease; flex-shrink: 0; margin-left: 4px;
      }
      .add-tab:hover { background: #2a5a9a; transform: scale(0.95); }
      .tab {
        display: flex; align-items: center; background: #1a1a1a;
        border-radius: 999px;
        padding: 4px 8px;
        gap: 6px;
        font-size: 12px;
        color: white;
        cursor: pointer;
        white-space: nowrap;
        border: 0.5px solid #333333;
        font-family: 'Inter', sans-serif;
        font-weight: 500;
        transition: min-width 0.2s cubic-bezier(0.2, 0.9, 0.4, 1.1), max-width 0.2s cubic-bezier(0.2, 0.9, 0.4, 1.1), background 0.2s ease, gap 0.2s, padding 0.2s, border-radius 0.2s ease;
      }
      .tab:not(.active) {
        width: 28px;
        height: 28px;
        min-width: 28px;
        max-width: 28px;
        padding: 0;
        justify-content: center;
        gap: 0;
        border-radius: 999px;
      }
      .tab:not(.active) .tab-title,
      .tab:not(.active) .tab-close {
        display: none;
      }
      .tab:not(.active) .tab-favicon {
        width: 18px;
        height: 18px;
      }
      .tab.active {
        min-width: 130px;
        max-width: 250px;
        padding: 4px 8px;
        gap: 6px;
        background: #2a5a9a;
        border-color: #3a6aaa;
        border-radius: 18px;
      }
      .tab-favicon {
        width: 16px;
        height: 16px;
        min-width: 16px;
        border-radius: 2px;
        object-fit: contain;
      }
      .tab-title {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        flex: 1 1 auto;
        min-width: 0;
      }
      .tab-close {
        background: transparent;
        border-radius: 50%;
        width: 22px;
        height: 22px;
        display: none;
        align-items: center;
        justify-content: center;
        font-size: 16px;
        font-weight: bold;
        cursor: pointer;
        transition: background 0.15s ease;
        color: rgba(255,255,255,0.9);
        line-height: 1;
        flex-shrink: 0;
      }
      .tab.active .tab-close {
        display: inline-flex;
      }
      .tab-close:hover {
        background: rgba(255, 60, 60, 0.9);
        color: white;
        transform: scale(1.05);
      }
      .tab-adding {
        animation: tabAppear 0.2s cubic-bezier(0.2, 0.9, 0.4, 1.1) forwards;
      }
      .tab-removing {
        animation: tabDisappear 0.15s cubic-bezier(0.4, 0, 0.6, 1) forwards;
        pointer-events: none;
      }
      @keyframes tabAppear {
        0% { opacity: 0; transform: scale(0.8); }
        100% { opacity: 1; transform: scale(1); }
      }
      @keyframes tabDisappear {
        0% { opacity: 1; transform: scale(1); }
        100% { opacity: 0; transform: scale(0.8); }
      }
      .nav-area {
        display: flex; gap: 6px; align-items: center; padding: 6px 8px;
        background: #111111; border-bottom: 0.5px solid #222222; flex-shrink: 0;
        overflow-x: hidden;
      }
      .nav-btn {
        background: #1a1a1a; border: 0.5px solid #333333;
        border-radius: 24px; padding: 5px 10px; font-family: 'Inter', sans-serif; font-size: 13px;
        color: white; cursor: pointer; transition: 0.15s; min-width: 32px; text-align: center;
        font-weight: 500;
      }
      .nav-btn:hover { background: #2a5a9a; transform: scale(0.97); }
      .nav-btn:disabled { opacity: 0.4; pointer-events: none; }
      .url-input-wrapper {
        flex: 1; min-width: 0; display: flex; align-items: center;
        background: #0a0a0a; border: 0.5px solid #333333; border-radius: 32px;
        padding: 0 12px; transition: background 0.15s, border-color 0.15s, box-shadow 0.15s;
        position: relative; overflow: hidden;
      }
      .url-input-wrapper:focus-within {
        background: #151515; border-color: #4a8ad0;
        box-shadow: 0 0 6px rgba(70, 150, 255, 0.3);
      }
      .url-input-wrapper .security-icon {
        font-size: 16px; margin-right: 6px; line-height: 1; flex-shrink: 0; z-index: 2;
      }
      .url-input-wrapper .url-input {
        flex: 1; min-width: 0; background: transparent; border: none; outline: none;
        font-family: 'Inter', sans-serif; font-size: 13px; color: white; font-weight: 500;
        padding: 6px 0; z-index: 2;
      }
      .load-progress {
        position: absolute;
        top: 0;
        left: 0;
        height: 100%;
        width: 0%;
        background: rgba(74, 138, 208, 0.25);
        z-index: 1;
        border-radius: 32px;
        opacity: 1;
        transition: width 0.3s linear, opacity 0.5s ease;
      }
      .load-progress.done {
        opacity: 0;
        width: 100%;
      }
      .save-page-btn {
        background: #1a1a1a; border: 0.5px solid #333333;
        border-radius: 24px; padding: 5px 10px; font-family: 'Inter', sans-serif; font-size: 16px;
        color: white; cursor: pointer; transition: 0.15s; min-width: 32px; text-align: center;
        font-weight: 500; flex-shrink: 0;
      }
      .save-page-btn:hover { background: #2a5a9a; }
      .context-menu {
        position: absolute; background: #2a2a2a; border: 0.5px solid #555; border-radius: 8px;
        padding: 4px 0; z-index: 300; display: none; box-shadow: 0 2px 10px rgba(0,0,0,0.7);
        white-space: nowrap;
        opacity: 0; transform: scale(0.95); transition: opacity 0.15s, transform 0.15s;
      }
      .context-menu.active {
        display: block; opacity: 1; transform: scale(1);
      }
      .context-menu-item {
        padding: 8px 16px; cursor: pointer; font-size: 13px; color: white;
      }
      .context-menu-item:hover { background: #3a3a3a; }
      .modal-overlay {
        position: fixed; top: 0; left: 0; width: 100%; height: 100%;
        background: rgba(0,0,0,0.6); z-index: 400; display: flex;
        align-items: center; justify-content: center;
        opacity: 0; transition: opacity 0.25s ease; pointer-events: none;
      }
      .modal-overlay.active { opacity: 1; pointer-events: auto; }
      .modal-box {
        background: #1e1e1e; border: 1px solid #444; border-radius: 16px;
        padding: 20px; text-align: center; min-width: 280px;
        box-shadow: 0 8px 20px rgba(0,0,0,0.8);
        transform: scale(0.9); transition: transform 0.25s cubic-bezier(0.2, 0.9, 0.4, 1.1);
      }
      .modal-overlay.active .modal-box { transform: scale(1); }
      .modal-message { color: white; font-size: 14px; margin-bottom: 16px; }
      .modal-buttons { display: flex; justify-content: center; gap: 12px; }
      .modal-btn {
        background: #2a5a9a; border: none; border-radius: 20px; padding: 8px 20px;
        color: white; font-weight: 500; cursor: pointer; font-size: 13px; transition: background 0.15s;
      }
      .modal-btn:hover { background: #1e4a8a; }
      .modal-btn.cancel { background: #555; }
      .modal-btn.cancel:hover { background: #666; }
      .webview-container { flex: 1; position: relative; background: #000000; overflow: hidden; }
      webview { position: absolute; top: 0; left: 0; width: 100%; height: 100%; background: #000000; }
      .home-screen {
        display: none; flex-direction: column; align-items: center;
        width: 100%; height: 100%; padding: 40px 20px 20px;
        overflow: hidden; position: relative;
      }
      .home-search-area {
        width: 100%; max-width: 600px; margin-bottom: 20px; flex-shrink: 0;
      }
      .home-search-input {
        width: 100%; background: #0a0a0a; border: 0.5px solid #333333; border-radius: 24px;
        padding: 8px 16px; font-family: 'Inter', sans-serif; font-size: 14px; color: white;
        outline: none; transition: border-color 0.15s;
      }
      .home-search-input:focus { border-color: #4a8ad0; }
      .home-links-scroll {
        flex: 1 1 auto; overflow-y: auto; min-height: 0; width: 100%;
        overflow-x: hidden;
      }
      .home-links-container {
        display: flex; flex-wrap: wrap; gap: 10px; justify-content: center; align-content: flex-start;
        padding: 5px;
      }
      .home-link-card {
        width: 100px;
        height: 100px;
        border-radius: 12px;
        background-color: #1a1a1a;
        background-size: cover;
        background-position: center;
        background-repeat: no-repeat;
        position: relative;
        cursor: pointer;
        transition: transform 0.15s, box-shadow 0.15s;
        overflow: hidden;
        box-shadow: 0 2px 8px rgba(0,0,0,0.4);
        flex-shrink: 0;
      }
      .home-link-card:hover {
        transform: scale(1.05);
        box-shadow: 0 4px 14px rgba(0,0,0,0.6);
        z-index: 2;
      }
      .home-link-title {
        position: absolute;
        bottom: 0;
        left: 0;
        right: 0;
        padding: 4px 4px;
        background: rgba(0,0,0,0.75);
        color: white;
        font-size: 10px;
        font-weight: 500;
        text-align: center;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        line-height: 1.2;
      }
      .home-add-link-area {
        position: absolute;
        bottom: 20px;
        right: 20px;
        z-index: 10;
      }
      .home-add-btn {
        background: #2a5a9a; border: none; border-radius: 50%; width: 40px; height: 40px;
        font-size: 24px; color: white; cursor: pointer; display: flex; align-items: center;
        justify-content: center; transition: background 0.15s, transform 0.1s;
      }
      .home-add-btn:hover { background: #1e4a8a; transform: scale(1.1); }
      .add-link-popup {
        position: absolute; bottom: 50px; right: 0;
        background: #1e1e1e; border: 1px solid #444; border-radius: 12px; padding: 12px;
        display: none; flex-direction: column; gap: 8px; z-index: 300;
        box-shadow: 0 4px 12px rgba(0,0,0,0.6);
        width: 250px;
      }
      .add-link-popup.active { display: flex; }
      .popup-input {
        background: #0a0a0a; border: 0.5px solid #333; border-radius: 8px;
        padding: 6px 10px; color: white; font-family: 'Inter', sans-serif; font-size: 13px;
        outline: none; width: 100%;
      }
      .popup-add-btn {
        background: #2a5a9a; border: none; border-radius: 8px; padding: 6px;
        color: white; cursor: pointer; font-weight: 500;
      }
      .startup-overlay {
        position: absolute; top: 0; left: 0; width: 100%; height: 100%;
        background: transparent; border-radius: 12px;
        z-index: 9999; pointer-events: none;
      }
      .startup-logo {
        position: absolute;
        top: 50%; left: 50%;
        transform: translate(-50%, -50%) scale(0);
        width: 24px; height: 24px; object-fit: contain;
        opacity: 0;
        transition: opacity 0.5s ease, transform 0.5s ease, left 0.6s ease, margin-left 0.6s ease;
      }
      .startup-logo.show {
        opacity: 1;
        transform: translate(-50%, -50%) scale(1);
      }
      .startup-logo.move-left {
        left: 14px;
        transform: translate(0, -50%) scale(1);
      }
      .startup-text {
        position: absolute;
        top: 50%; left: 46px;
        transform: translateY(-50%) translateX(20px);
        color: white; font-size: 13px; font-weight: 600;
        opacity: 0;
        transition: opacity 0.6s ease, transform 0.6s ease;
        white-space: nowrap;
      }
      .startup-text.show-text {
        opacity: 1;
        transform: translateY(-50%) translateX(0);
      }
      ${wallpaperUrl ? `
      .dynamic-island {
        background-image: url('${wallpaperUrl.replace(/'/g, "\\'")}');
        background-size: cover;
        background-position: center;
        background-repeat: no-repeat;
        background-color: transparent !important;
      }
      .dynamic-island.home-active {
        background-color: transparent !important;
      }
      .dynamic-island:not(.home-active):hover {
        background-color: rgba(0,0,0,0.5) !important;
        background-blend-mode: darken;
      }
      ` : ''}
    </style>
  </head>
  <body>
    <audio id="clickSound" src="${clickSoundPath}" preload="auto"></audio>
    <audio id="startupSound" src="${startupSoundPath}" preload="auto"></audio>
    <audio id="questionSound" src="${questionSoundPath}" preload="auto"></audio>
    <div class="dynamic-island" id="island" style="opacity:0;">
      <div class="collapsed-content">
        <span class="collapsed-time" id="collapsedTime">00:00</span>
      </div>
      <div class="browser-container" id="browserContainer">
        <div class="tabs-bar" id="tabsBar">
          <div class="tabs-scroll" id="tabsScroll"></div>
          <div class="add-tab" id="addTabBtn">+</div>
        </div>
        <div class="nav-area" id="navArea">
          <button class="nav-btn" id="backBtn">◀</button>
          <button class="nav-btn" id="forwardBtn">▶</button>
          <button class="nav-btn" id="reloadBtn">⟳</button>
          <div class="url-input-wrapper" id="urlInputWrapper">
            <span id="securityIcon" class="security-icon"></span>
            <input type="text" class="url-input" id="urlInput" placeholder="URL или поиск">
            <div class="load-progress" id="loadProgress"></div>
          </div>
          <button class="save-page-btn" id="savePageBtn">💾</button>
        </div>
        <div class="home-screen" id="homeScreen">
          <div class="home-search-area">
            <input type="text" class="home-search-input" id="homeSearchInput" placeholder="Поиск в Google">
          </div>
          <div class="home-links-scroll">
            <div class="home-links-container" id="homeLinksContainer"></div>
          </div>
          <div class="home-add-link-area">
            <button class="home-add-btn" id="homeAddBtn">+</button>
            <div class="add-link-popup" id="addLinkPopup">
              <input type="text" class="popup-input" id="popupLinkInput" placeholder="Введите URL">
              <button class="popup-add-btn" id="popupAddBtn">Добавить</button>
            </div>
          </div>
        </div>
        <div class="webview-container" id="webviewContainer"></div>
      </div>
      <div class="context-menu" id="contextMenu">
        <div class="context-menu-item" id="ctxCopy">Копировать ссылку</div>
        <div class="context-menu-item" id="ctxDelete">Удалить</div>
      </div>
      <div class="modal-overlay" id="confirmModal">
        <div class="modal-box">
          <div class="modal-message" id="modalMessage">Вы уверены, что хотите удалить эту ссылку?</div>
          <div class="modal-buttons">
            <button class="modal-btn" id="modalYes">Да</button>
            <button class="modal-btn cancel" id="modalNo">Нет</button>
          </div>
        </div>
      </div>
    </div>
    <script>
      window.__STARTUP_ANIMATION = ${startupAnimFlag};
      window.__LOGO_DATA_URI = "${logoDataUri.replace(/"/g, '\\"')}";
    </script>
    <script>
      const { ipcRenderer } = require('electron');
      const island = document.getElementById('island');
      const browserContainer = document.getElementById('browserContainer');
      const urlInput = document.getElementById('urlInput');
      const backBtn = document.getElementById('backBtn');
      const forwardBtn = document.getElementById('forwardBtn');
      const reloadBtn = document.getElementById('reloadBtn');
      const tabsScroll = document.getElementById('tabsScroll');
      const addTabBtn = document.getElementById('addTabBtn');
      const webviewContainer = document.getElementById('webviewContainer');
      const securityIcon = document.getElementById('securityIcon');
      const urlInputWrapper = document.getElementById('urlInputWrapper');
      const loadProgress = document.getElementById('loadProgress');
      const savePageBtn = document.getElementById('savePageBtn');
      const contextMenu = document.getElementById('contextMenu');
      const ctxCopy = document.getElementById('ctxCopy');
      const ctxDelete = document.getElementById('ctxDelete');
      const confirmModal = document.getElementById('confirmModal');
      const modalYes = document.getElementById('modalYes');
      const modalNo = document.getElementById('modalNo');
      const collapsedTime = document.getElementById('collapsedTime');
      const navArea = document.getElementById('navArea');
      const homeScreen = document.getElementById('homeScreen');
      const homeSearchInput = document.getElementById('homeSearchInput');
      const homeLinksContainer = document.getElementById('homeLinksContainer');
      const homeAddBtn = document.getElementById('homeAddBtn');
      const addLinkPopup = document.getElementById('addLinkPopup');
      const popupLinkInput = document.getElementById('popupLinkInput');
      const popupAddBtn = document.getElementById('popupAddBtn');
      const clickSound = document.getElementById('clickSound');
      const startupSound = document.getElementById('startupSound');
      const questionSound = document.getElementById('questionSound');

      function playClick() {
        try { clickSound.currentTime = 0; clickSound.play().catch(() => {}); } catch(e) {}
      }

      let tabs = [];
      let activeTabId = null;
      let nextTabId = 1;
      let hoverModeEnabled = false;
      let savedLinks = [];
      let currentContextLink = null;
      let startupOverlay = null;
      let progressInterval = null;
      let progressTarget = 0;
      let progressValue = 0;
      let progressResetTimeout = null;
      let draggedIndex = null;

      function updateTime() {
        const now = new Date();
        const h = now.getHours().toString().padStart(2,'0');
        const m = now.getMinutes().toString().padStart(2,'0');
        if (collapsedTime) collapsedTime.textContent = h + ':' + m;
      }
      setInterval(updateTime, 60000);
      updateTime();

      if (window.__STARTUP_ANIMATION) {
        collapsedTime.classList.remove('visible');
      } else {
        collapsedTime.classList.add('visible');
      }

      function normalizeUrl(input) {
        input = input.trim();
        if (!input) return null;
        if (input.includes('.') && !input.includes(' ')) {
          if (!input.startsWith('http://') && !input.startsWith('https://')) return 'https://' + input;
          return input;
        }
        return 'https://www.google.com/search?q=' + encodeURIComponent(input);
      }

      function isErrorPage(url) {
        return url && url.startsWith('data:text/html');
      }

      function getHostnameFromUrl(url) {
        try { return new URL(url).hostname; } catch (e) { return url; }
      }

      function getFaviconUrl(url, size = 16) {
        const hostname = getHostnameFromUrl(url);
        return 'https://www.google.com/s2/favicons?domain=' + hostname + '&sz=' + size;
      }

      function normalizeLinkObject(item) {
        if (typeof item === 'string') {
          const hostname = getHostnameFromUrl(item);
          return { url: item, title: hostname, favicon: getFaviconUrl(item, 16) };
        }
        if (!item.title) item.title = getHostnameFromUrl(item.url);
        if (!item.favicon) item.favicon = getFaviconUrl(item.url, 16);
        return item;
      }

      function loadSavedLinks() {
        savedLinks = ipcRenderer.sendSync('get-saved-links').map(normalizeLinkObject);
        renderHomeLinks();
      }

      function saveLinksToStorage() {
        ipcRenderer.send('save-saved-links', savedLinks);
      }

      function showErrorMessage(webview, failedUrl, errorCode) {
        const escapedUrl = failedUrl.replace(/'/g, "\\\\'");
        let title = 'Не удалось загрузить страницу';
        let description = 'Проверьте адрес и попробуйте снова';
        if (errorCode === -105) {
          title = 'Проблема с подключением к сайту';
          description = 'Не удалось найти сервер по этому адресу';
        } else if (errorCode === -106) {
          title = 'Нет подключения к интернету';
          description = 'Проверьте соединение и попробуйте снова';
        } else if (errorCode === -7 || errorCode === -102 || errorCode === -118) {
          title = 'Сайт не отвечает';
          description = 'Возможно, сервер недоступен или перегружен';
        }
        const errorHtml = \`<html style="background:#000000; color:white; display:flex; align-items:center; justify-content:center; height:100%; font-family:'Inter',sans-serif;"><body style="text-align:center; margin:0;"><div style="padding:20px;"><div style="font-size:48px; margin-bottom:16px;">⚠️</div><div style="font-size:18px; font-weight:600; margin-bottom:8px;">\${title}</div><div style="font-size:14px; color:#aaa;">\${description}</div><button onclick="location.href='\${escapedUrl}'" style="margin-top:20px; padding:8px 20px; background:#2a5a9a; border:none; border-radius:20px; color:white; cursor:pointer; font-family:'Inter',sans-serif; font-weight:500;">Повторить</button></div></body></html>\`;
        webview.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(errorHtml));
      }

      function reloadAllErrorPages() {
        tabs.forEach(tab => {
          const wv = tab.webview;
          if (wv && wv.src && isErrorPage(wv.src) && tab.originalUrl && !isErrorPage(tab.originalUrl)) {
            wv.src = tab.originalUrl;
          }
        });
      }

      function updateSecurityIcon(url) {
        if (!securityIcon) return;
        if (url && url.startsWith('https://')) {
          securityIcon.textContent = '🔒';
          securityIcon.title = 'Безопасное соединение';
          securityIcon.style.color = '#4caf50';
        } else if (url && url.startsWith('http://')) {
          securityIcon.textContent = '🔓';
          securityIcon.title = 'Небезопасное соединение';
          securityIcon.style.color = '#ff9800';
        } else {
          securityIcon.textContent = '';
          securityIcon.title = '';
        }
      }

      function updateUrlInput() {
        const activeTab = tabs.find(t => t.id === activeTabId);
        if (!activeTab || activeTab.type !== 'web') {
          urlInput.value = '';
          updateSecurityIcon('');
          return;
        }
        let urlToShow = activeTab.displayUrl;
        if (isErrorPage(urlToShow)) {
          urlToShow = activeTab.originalUrl || '';
        }
        urlInput.value = urlToShow;
        updateSecurityIcon(urlToShow);
      }

      function updateNavButtons() {
        const activeTab = tabs.find(t => t.id === activeTabId);
        if (activeTab && activeTab.type === 'web') {
          backBtn.disabled = false;
          forwardBtn.disabled = false;
          reloadBtn.disabled = false;
        } else {
          backBtn.disabled = true;
          forwardBtn.disabled = true;
          reloadBtn.disabled = true;
        }
      }

      function canAddTab() {
        if (!tabsScroll || !addTabBtn) return true;
        const scrollWidth = tabsScroll.clientWidth;
        const addBtnWidth = addTabBtn.offsetWidth + 4;
        let tabsWidth = 0;
        const tabElements = tabsScroll.querySelectorAll('.tab');
        for (let i = 0; i < tabElements.length; i++) {
          tabsWidth += tabElements[i].offsetWidth;
          if (i < tabElements.length - 1) tabsWidth += 4;
        }
        const newTabMinWidth = 28;
        return scrollWidth - addBtnWidth - tabsWidth >= newTabMinWidth;
      }

      function clearProgressInterval() {
        if (progressInterval) {
          clearInterval(progressInterval);
          progressInterval = null;
        }
      }

      function clearProgressResetTimeout() {
        if (progressResetTimeout) {
          clearTimeout(progressResetTimeout);
          progressResetTimeout = null;
        }
      }

      function forceResetProgressBar() {
        clearProgressResetTimeout();
        loadProgress.style.transition = 'none';
        loadProgress.style.width = '0%';
        loadProgress.classList.remove('done');
        loadProgress.style.opacity = '1';
        void loadProgress.offsetWidth;
        loadProgress.style.transition = '';
        progressValue = 0;
        progressTarget = 0;
      }

      function startSimulatedProgress() {
        clearProgressInterval();
        forceResetProgressBar();
        progressTarget = 85;
        progressInterval = setInterval(() => {
          if (progressValue < progressTarget) {
            progressValue += Math.random() * 10 + 5;
            if (progressValue > progressTarget) progressValue = progressTarget;
            loadProgress.style.width = progressValue + '%';
          } else {
            clearProgressInterval();
            progressInterval = setInterval(() => {
              if (progressValue < 95) {
                progressValue += 0.5;
                loadProgress.style.width = progressValue + '%';
              } else {
                clearProgressInterval();
                progressInterval = null;
              }
            }, 200);
          }
        }, 120);
      }

      function finishSimulatedProgress() {
        clearProgressInterval();
        clearProgressResetTimeout();
        progressValue = 100;
        loadProgress.style.width = '100%';
        loadProgress.classList.add('done');
        progressResetTimeout = setTimeout(() => {
          loadProgress.style.transition = 'none';
          loadProgress.style.width = '0%';
          loadProgress.classList.remove('done');
          loadProgress.style.opacity = '1';
          void loadProgress.offsetWidth;
          loadProgress.style.transition = '';
          progressResetTimeout = null;
        }, 550);
      }

      function createWebview(url, id) {
        const startUrl = url || 'https://www.google.com';
        const webview = document.createElement('webview');
        webview.setAttribute('src', startUrl);
        webview.setAttribute('partition', 'persist:main');
        webview.setAttribute('allowpopups', 'true');
        webview.style.display = 'none';

        webview.addEventListener('did-fail-load', (e) => {
          if (e.errorCode !== -3 && e.errorCode !== 0 && e.errorCode !== -1) {
            const failed = e.validatedURL || startUrl;
            const tab = tabs.find(t => t.id === id);
            if (tab && !isErrorPage(webview.src)) tab.originalUrl = failed;
            showErrorMessage(webview, failed, e.errorCode);
          }
        });
        webview.addEventListener('did-start-loading', () => {
          const tab = tabs.find(t => t.id === id);
          if (tab && activeTabId === id && tab.type === 'web') {
            reloadBtn.textContent = '⛔';
            startSimulatedProgress();
          }
        });
        webview.addEventListener('did-navigate', () => {
          const tab = tabs.find(t => t.id === id);
          if (tab && activeTabId === id && tab.type === 'web') {
            if (!isErrorPage(webview.src)) tab.displayUrl = webview.src;
            updateUrlInput();
          }
        });
        webview.addEventListener('did-navigate-in-page', () => {
          const tab = tabs.find(t => t.id === id);
          if (tab && activeTabId === id && tab.type === 'web') {
            if (!isErrorPage(webview.src)) tab.displayUrl = webview.src;
            updateUrlInput();
          }
        });
        webview.addEventListener('page-title-updated', (e) => {
          const tab = tabs.find(t => t.id === id);
          if (tab) {
            tab.title = e.title || 'Новая вкладка';
            if (tab.element) {
              const titleEl = tab.element.querySelector('.tab-title');
              if (titleEl) titleEl.textContent = tab.title;
              tab.element.title = tab.title;
            }
          }
        });
        webview.addEventListener('page-favicon-updated', (e) => {
          const tab = tabs.find(t => t.id === id);
          if (tab && e.favicons && e.favicons.length > 0) {
            tab.favicon = e.favicons[0];
            if (tab.element) {
              const img = tab.element.querySelector('.tab-favicon');
              if (img) img.src = tab.favicon;
            }
          }
        });
        webview.addEventListener('did-stop-loading', () => {
          const tab = tabs.find(t => t.id === id);
          if (tab && activeTabId === id && tab.type === 'web') {
            reloadBtn.textContent = '⟳';
            if (!isErrorPage(webview.src)) tab.displayUrl = webview.src;
            updateUrlInput();
            finishSimulatedProgress();
          }
          if (tab && !isErrorPage(webview.src) && (!tab.originalUrl || isErrorPage(tab.originalUrl))) {
            tab.originalUrl = webview.src;
          }
        });
        webview.addEventListener('enter-html-full-screen', () => ipcRenderer.send('fullscreen-enter'));
        webview.addEventListener('leave-html-full-screen', () => ipcRenderer.send('fullscreen-leave'));
        return webview;
      }

      function createTabElement(tab) {
        const tabEl = document.createElement('div');
        tabEl.className = 'tab';
        tabEl.setAttribute('data-id', tab.id);
        tabEl.title = tab.title || 'Новая вкладка';
        const img = document.createElement('img');
        img.className = 'tab-favicon';
        img.src = tab.favicon || '';
        img.draggable = false;
        const titleSpan = document.createElement('span');
        titleSpan.className = 'tab-title';
        titleSpan.textContent = tab.title || 'Новая вкладка';
        const closeSpan = document.createElement('span');
        closeSpan.className = 'tab-close';
        closeSpan.textContent = '×';
        closeSpan.addEventListener('click', (e) => {
          e.stopPropagation();
          playClick();
          closeTabWithAnimation(tab.id);
        });
        tabEl.appendChild(img);
        tabEl.appendChild(titleSpan);
        tabEl.appendChild(closeSpan);
        tabEl.addEventListener('click', () => {
          switchToTab(tab.id);
        });
        tab.element = tabEl;
        return tabEl;
      }

      function addTab(url, activate = true) {
        if (!canAddTab()) return false;
        const id = nextTabId++;
        if (url) {
          const webview = createWebview(url, id);
          webview.setAttribute('data-id', id);
          webviewContainer.appendChild(webview);
          const newTab = { id, type: 'web', title: 'Загрузка...', favicon: '', originalUrl: url, displayUrl: url, webview, element: null };
          tabs.push(newTab);
          const tabEl = createTabElement(newTab);
          tabsScroll.appendChild(tabEl);
          if (activate) {
            tabEl.classList.add('active');
            if (activeTabId !== null) {
              const prevTab = tabs.find(t => t.id === activeTabId);
              if (prevTab && prevTab.element) prevTab.element.classList.remove('active');
              const prevWebview = prevTab?.webview;
              if (prevWebview) prevWebview.style.display = 'none';
            }
            activeTabId = id;
            webview.style.display = 'flex';
            homeScreen.style.display = 'none';
            island.classList.remove('home-active');
            updateNavButtons();
            if (webview.isLoading()) {
              reloadBtn.textContent = '⛔';
              startSimulatedProgress();
            } else {
              reloadBtn.textContent = '⟳';
            }
          } else {
            webview.style.display = 'none';
          }
          tabEl.classList.add('tab-adding');
          tabEl.addEventListener('animationend', () => tabEl.classList.remove('tab-adding'), { once: true });
          return true;
        } else {
          const homeTab = { id, type: 'home', title: 'Главная', favicon: window.__LOGO_DATA_URI || '', originalUrl: '', displayUrl: '', webview: null, element: null };
          tabs.push(homeTab);
          const tabEl = createTabElement(homeTab);
          tabsScroll.appendChild(tabEl);
          if (activate) {
            tabEl.classList.add('active');
            if (activeTabId !== null) {
              const prevTab = tabs.find(t => t.id === activeTabId);
              if (prevTab && prevTab.element) prevTab.element.classList.remove('active');
              if (prevTab && prevTab.webview) prevTab.webview.style.display = 'none';
            }
            activeTabId = id;
            homeScreen.style.display = 'flex';
            homeSearchInput.value = '';
            urlInput.value = '';
            webviewContainer.querySelectorAll('webview').forEach(wv => wv.style.display = 'none');
            island.classList.add('home-active');
            updateNavButtons();
            reloadBtn.textContent = '⟳';
          }
          tabEl.classList.add('tab-adding');
          tabEl.addEventListener('animationend', () => tabEl.classList.remove('tab-adding'), { once: true });
          return true;
        }
      }

      function convertTabToWeb(tabId, url) {
        const tab = tabs.find(t => t.id === tabId);
        if (!tab || tab.type === 'web') return;
        const webview = createWebview(url, tabId);
        webviewContainer.appendChild(webview);
        tab.webview = webview;
        tab.type = 'web';
        tab.originalUrl = url;
        tab.displayUrl = url;
        tab.favicon = getFaviconUrl(url, 16);
        tab.title = getHostnameFromUrl(url);
        if (tab.element && tab.element.parentNode) {
          tab.element.parentNode.removeChild(tab.element);
        }
        const newEl = createTabElement(tab);
        tabsScroll.appendChild(newEl);
        tab.element = newEl;
        if (activeTabId === tabId) {
          switchToTab(tabId);
        }
      }

      function convertWebToHome(tabId) {
        const tab = tabs.find(t => t.id === tabId);
        if (!tab || tab.type !== 'web') return;
        if (tab.webview) tab.webview.remove();
        tab.type = 'home';
        tab.title = 'Главная';
        tab.favicon = window.__LOGO_DATA_URI || '';
        tab.originalUrl = '';
        tab.displayUrl = '';
        tab.webview = null;
        if (tab.element && tab.element.parentNode) {
          tab.element.parentNode.removeChild(tab.element);
        }
        const newEl = createTabElement(tab);
        tabsScroll.appendChild(newEl);
        tab.element = newEl;
        if (activeTabId === tabId) {
          homeScreen.style.display = 'flex';
          homeSearchInput.value = '';
          urlInput.value = '';
          webviewContainer.querySelectorAll('webview').forEach(wv => wv.style.display = 'none');
          island.classList.add('home-active');
          updateNavButtons();
          reloadBtn.textContent = '⟳';
          const activeEl = tabsScroll.querySelector(\`.tab[data-id='\${tabId}']\`);
          if (activeEl) activeEl.classList.add('active');
        }
      }

      function switchToTab(id) {
        const tab = tabs.find(t => t.id === id);
        if (!tab) return;
        webviewContainer.querySelectorAll('webview').forEach(wv => wv.style.display = 'none');
        homeScreen.style.display = 'none';
        if (activeTabId !== null) {
          const prevTab = tabs.find(t => t.id === activeTabId);
          if (prevTab && prevTab.element) prevTab.element.classList.remove('active');
        }
        activeTabId = id;
        if (tab.element) tab.element.classList.add('active');
        if (tab.type === 'home') {
          homeScreen.style.display = 'flex';
          homeSearchInput.value = '';
          urlInput.value = '';
          island.classList.add('home-active');
        } else {
          island.classList.remove('home-active');
          if (tab.webview) {
            tab.webview.style.display = 'flex';
            let urlToShow = tab.displayUrl;
            if (isErrorPage(urlToShow)) urlToShow = tab.originalUrl || '';
            urlInput.value = urlToShow;
            updateSecurityIcon(urlToShow);
            if (tab.webview.isLoading()) {
              reloadBtn.textContent = '⛔';
              startSimulatedProgress();
            } else {
              reloadBtn.textContent = '⟳';
              finishSimulatedProgress();
            }
          }
        }
        updateNavButtons();
      }

      function closeTabWithAnimation(id) {
        const tab = tabs.find(t => t.id === id);
        if (!tab || !tab.element) { closeTab(id); return; }
        const tabEl = tab.element;
        tabEl.classList.add('tab-removing');
        const onAnimEnd = () => {
          tabEl.removeEventListener('animationend', onAnimEnd);
          if (tabEl.parentNode) tabEl.parentNode.removeChild(tabEl);
          closeTab(id);
        };
        tabEl.addEventListener('animationend', onAnimEnd);
      }

      function closeTab(id) {
        const index = tabs.findIndex(t => t.id === id);
        if (index === -1) return;
        const tab = tabs[index];
        if (tab.webview) tab.webview.remove();
        tabs.splice(index, 1);
        if (tabs.length === 0) addTab(null, true);
        else if (activeTabId === id) switchToTab(tabs[Math.min(index, tabs.length - 1)].id);
      }

      function renderHomeLinks() {
        if (!homeLinksContainer) return;
        const oldCards = [...homeLinksContainer.querySelectorAll('.home-link-card')];
        const oldRectsMap = new Map();
        oldCards.forEach(card => {
          oldRectsMap.set(card.dataset.index, card.getBoundingClientRect());
        });
        homeLinksContainer.innerHTML = '';
        savedLinks.forEach((linkObj, index) => {
          const card = document.createElement('div');
          card.className = 'home-link-card';
          const cardFaviconUrl = getFaviconUrl(linkObj.url, 128);
          card.style.backgroundImage = \`url(\${cardFaviconUrl})\`;
          card.title = linkObj.title || getHostnameFromUrl(linkObj.url);
          card.setAttribute('draggable', 'true');
          card.dataset.index = index;
          const titleSpan = document.createElement('span');
          titleSpan.className = 'home-link-title';
          titleSpan.textContent = linkObj.title || getHostnameFromUrl(linkObj.url);
          card.appendChild(titleSpan);

          card.addEventListener('dragstart', (e) => {
            draggedIndex = parseInt(e.currentTarget.dataset.index, 10);
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', '');
            e.currentTarget.style.opacity = '0.5';
          });
          card.addEventListener('dragend', (e) => {
            e.currentTarget.style.opacity = '1';
            draggedIndex = null;
          });
          card.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
          });
          card.addEventListener('drop', (e) => {
            e.preventDefault();
            const targetIndex = parseInt(e.currentTarget.dataset.index, 10);
            if (draggedIndex !== null && draggedIndex !== targetIndex) {
              const movedItem = savedLinks.splice(draggedIndex, 1)[0];
              savedLinks.splice(targetIndex, 0, movedItem);
              saveLinksToStorage();
              renderHomeLinks();
            }
          });

          card.addEventListener('click', () => {
            const normalized = normalizeUrl(linkObj.url);
            if (!normalized) return;
            const activeTab = tabs.find(t => t.id === activeTabId);
            if (activeTab && activeTab.type === 'home') {
              convertTabToWeb(activeTabId, normalized);
            } else {
              addTab(normalized, true);
            }
          });
          card.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
            playClick();
            currentContextLink = linkObj;
            const rect = island.getBoundingClientRect();
            let left = e.clientX - rect.left;
            let top = e.clientY - rect.top;
            const menuWidth = contextMenu.offsetWidth || 150;
            const menuHeight = contextMenu.offsetHeight || 80;
            if (left + menuWidth > rect.width) left = rect.width - menuWidth - 5;
            if (top + menuHeight > rect.height) top = rect.height - menuHeight - 5;
            if (left < 5) left = 5;
            if (top < 5) top = 5;
            contextMenu.style.left = left + 'px';
            contextMenu.style.top = top + 'px';
            contextMenu.classList.add('active');
          });
          homeLinksContainer.appendChild(card);
        });

        requestAnimationFrame(() => {
          const newCards = [...homeLinksContainer.querySelectorAll('.home-link-card')];
          newCards.forEach(card => {
            const idx = card.dataset.index;
            const oldRect = oldRectsMap.get(idx);
            if (oldRect) {
              const newRect = card.getBoundingClientRect();
              const deltaX = oldRect.left - newRect.left;
              const deltaY = oldRect.top - newRect.top;
              if (deltaX !== 0 || deltaY !== 0) {
                card.style.transition = 'none';
                card.style.transform = \`translate(\${deltaX}px, \${deltaY}px)\`;
                requestAnimationFrame(() => {
                  card.style.transition = 'transform 0.2s ease';
                  card.style.transform = '';
                });
              }
            }
          });
        });
      }

      function hideContextMenu() { contextMenu.classList.remove('active'); }
      function showConfirmModal() {
        try { questionSound.currentTime = 0; questionSound.play().catch(() => {}); } catch(e) {}
        confirmModal.classList.add('active');
      }
      function hideConfirmModal() { confirmModal.classList.remove('active'); currentContextLink = null; }

      ctxCopy.addEventListener('click', () => {
        playClick();
        if (currentContextLink) {
          const textArea = document.createElement('textarea');
          textArea.value = currentContextLink.url;
          document.body.appendChild(textArea);
          textArea.select();
          try { document.execCommand('copy'); } catch (err) {}
          document.body.removeChild(textArea);
        }
        hideContextMenu();
      });

      ctxDelete.addEventListener('click', () => {
        playClick();
        if (currentContextLink) showConfirmModal();
        hideContextMenu();
      });

      modalYes.addEventListener('click', () => {
        playClick();
        if (currentContextLink) {
          savedLinks = savedLinks.filter(l => l.url !== currentContextLink.url);
          saveLinksToStorage();
          renderHomeLinks();
        }
        hideConfirmModal();
      });

      modalNo.addEventListener('click', () => {
        playClick();
        hideConfirmModal();
      });
      confirmModal.addEventListener('click', (e) => { if (e.target === confirmModal) hideConfirmModal(); });

      document.addEventListener('click', (e) => {
        if (!contextMenu.contains(e.target)) hideContextMenu();
        if (addLinkPopup.classList.contains('active') && !addLinkPopup.contains(e.target) && e.target !== homeAddBtn) {
          addLinkPopup.classList.remove('active');
        }
      });

      savePageBtn.addEventListener('click', () => {
        playClick();
        const activeTab = tabs.find(t => t.id === activeTabId);
        if (activeTab && activeTab.type === 'web') {
          const url = activeTab.displayUrl || activeTab.originalUrl;
          if (url && !url.startsWith('data:') && !url.startsWith('javascript:') && url !== 'about:blank') {
            const existing = savedLinks.find(l => l.url === url);
            if (existing) {
              existing.title = activeTab.title || getHostnameFromUrl(url);
              existing.favicon = activeTab.favicon || getFaviconUrl(url, 16);
            } else {
              savedLinks.push({
                url: url,
                title: activeTab.title || getHostnameFromUrl(url),
                favicon: activeTab.favicon || getFaviconUrl(url, 16)
              });
            }
            saveLinksToStorage();
            renderHomeLinks();
          }
        }
      });

      homeSearchInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
          playClick();
          const query = homeSearchInput.value.trim();
          if (!query) return;
          const searchUrl = 'https://www.google.com/search?q=' + encodeURIComponent(query);
          const activeTab = tabs.find(t => t.id === activeTabId);
          if (activeTab && activeTab.type === 'home') {
            convertTabToWeb(activeTabId, searchUrl);
            homeSearchInput.value = '';
          } else {
            addTab(searchUrl, true);
          }
        }
      });

      homeAddBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        playClick();
        addLinkPopup.classList.toggle('active');
      });

      popupAddBtn.addEventListener('click', () => {
        playClick();
        const rawUrl = popupLinkInput.value.trim();
        if (!rawUrl) return;
        const normalized = normalizeUrl(rawUrl) || rawUrl;
        const existing = savedLinks.find(l => l.url === normalized);
        if (existing) {
          popupLinkInput.value = '';
          addLinkPopup.classList.remove('active');
          return;
        }
        const tempObj = { url: normalized, title: getHostnameFromUrl(normalized), favicon: getFaviconUrl(normalized, 16) };
        savedLinks.push(tempObj);
        saveLinksToStorage();
        renderHomeLinks();
        popupLinkInput.value = '';
        addLinkPopup.classList.remove('active');
      });

      island.addEventListener('click', (e) => {
        if (e.target === urlInput || e.target === backBtn || e.target === forwardBtn || e.target === reloadBtn || e.target.closest('.tab') || e.target === addTabBtn || e.target.closest('.add-tab') || e.target.closest('.url-input-wrapper') || e.target === savePageBtn) return;
        if (contextMenu.classList.contains('active') && !contextMenu.contains(e.target)) {
          hideContextMenu();
          return;
        }
        if (addLinkPopup.classList.contains('active') && !addLinkPopup.contains(e.target) && e.target !== homeAddBtn) {
          addLinkPopup.classList.remove('active');
          return;
        }
        e.stopPropagation();
        if (!island.classList.contains('expanded') && !hoverModeEnabled) ipcRenderer.send('expand-island');
      });

      ipcRenderer.on('open-new-tab', (e, url) => {
        if (url && url !== 'about:blank' && !url.startsWith('javascript:')) addTab(url, true);
      });

      backBtn.addEventListener('click', () => {
        playClick();
        const tab = tabs.find(t => t.id === activeTabId);
        if (tab && tab.type === 'web') {
          if (tab.webview && tab.webview.canGoBack()) {
            tab.webview.goBack();
          } else {
            convertWebToHome(tab.id);
          }
        }
      });
      forwardBtn.addEventListener('click', () => {
        playClick();
        const tab = tabs.find(t => t.id === activeTabId);
        if (tab && tab.type === 'web' && tab.webview && tab.webview.canGoForward()) tab.webview.goForward();
      });
      reloadBtn.addEventListener('click', () => {
        playClick();
        const tab = tabs.find(t => t.id === activeTabId);
        if (tab && tab.type === 'web' && tab.webview) {
          if (tab.webview.isLoading()) tab.webview.stop();
          else tab.webview.reload();
        }
      });
      urlInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
          playClick();
          const url = normalizeUrl(urlInput.value);
          if (url) {
            const tab = tabs.find(t => t.id === activeTabId);
            if (tab && tab.type === 'home') {
              convertTabToWeb(activeTabId, url);
            } else if (tab && tab.type === 'web' && tab.webview) {
              tab.webview.src = url;
              tab.originalUrl = url;
            }
          }
        }
      });
      addTabBtn.addEventListener('click', () => { playClick(); addTab(null, true); });

      window.addEventListener('online', () => reloadAllErrorPages());
      window.addEventListener('resize', () => { if (tabs.length === 0) addTab(null, true); });

      ipcRenderer.on('hover-mode-changed', (event, enabled) => { hoverModeEnabled = enabled; });
      hoverModeEnabled = ipcRenderer.sendSync('get-hover-mode');

      island.addEventListener('mouseenter', () => {
        if (hoverModeEnabled && !island.classList.contains('expanded')) ipcRenderer.send('expand-island');
      });

      ipcRenderer.on('clear-search-reset', () => {
        browserContainer.style.display = 'none';
      });
      ipcRenderer.on('show-browser', () => {
        browserContainer.style.display = 'flex';
        if (collapsedTime) {
          collapsedTime.style.display = 'none';
          collapsedTime.classList.remove('visible');
        }
        if (tabs.length === 0) addTab(null, true);
        else if (activeTabId === null && tabs.length) switchToTab(tabs[0].id);
        loadSavedLinks();
      });

      function removeStartupOverlay() {
        if (startupOverlay && startupOverlay.parentNode) {
          startupOverlay.parentNode.removeChild(startupOverlay);
          startupOverlay = null;
        }
      }

      ipcRenderer.on('hide-startup-overlay', () => {
        removeStartupOverlay();
        if (collapsedTime) {
          collapsedTime.classList.add('visible');
          collapsedTime.style.display = '';
        }
      });

      (function initStartup() {
        const startupEnabled = window.__STARTUP_ANIMATION;
        if (startupEnabled) {
          try { startupSound.currentTime = 0; startupSound.play().catch(() => {}); } catch(e) {}
          startupOverlay = document.createElement('div');
          startupOverlay.className = 'startup-overlay';
          const logoImg = document.createElement('img');
          logoImg.className = 'startup-logo';
          logoImg.src = window.__LOGO_DATA_URI || '';
          const textSpan = document.createElement('span');
          textSpan.className = 'startup-text';
          textSpan.textContent = 'Dynamic Browser';
          startupOverlay.appendChild(logoImg);
          startupOverlay.appendChild(textSpan);
          island.parentNode.appendChild(startupOverlay);
          requestAnimationFrame(() => {
            logoImg.classList.add('show');
          });
          setTimeout(() => {
            logoImg.classList.add('move-left');
          }, 800);
          setTimeout(() => {
            textSpan.classList.add('show-text');
          }, 1000);
          setTimeout(() => {
            startupOverlay.style.transition = 'opacity 0.5s ease';
            startupOverlay.style.opacity = '0';
            setTimeout(() => {
              removeStartupOverlay();
              if (collapsedTime) {
                collapsedTime.classList.add('visible');
                collapsedTime.style.display = '';
              }
            }, 500);
          }, 3000);
        }
      })();

      addTab(null, true);
      loadSavedLinks();
    </script>
  </body>
  </html>
  `;

  mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    mainWindow.webContents.send('hover-mode-changed', appSettings.hoverToOpen);
  });
  mainWindow.on('close', e => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
}

function animateResize(fromW, fromH, toW, toH, duration = 220) {
  return new Promise(resolve => {
    if (currentAnimation) { clearInterval(currentAnimation); currentAnimation = null; }
    const start = Date.now();
    const easeOutCubic = t => 1 - Math.pow(1 - t, 3);
    isAnimating = true;
    const step = () => {
      const elapsed = Date.now() - start;
      const rawProgress = Math.min(1, elapsed / duration);
      const progress = easeOutCubic(rawProgress);
      const w = Math.round(fromW + (toW - fromW) * progress);
      const h = Math.round(fromH + (toH - fromH) * progress);
      updateCurrentDisplay();
      const x = getXForDock(w, dockPosition, currentDisplay);
      const y = currentDisplay.bounds.y;
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setBounds({ width: w, height: h, x, y });
      if (rawProgress < 1) currentAnimation = setTimeout(step, 10);
      else {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setBounds({ width: toW, height: toH, x: getXForDock(toW, dockPosition, currentDisplay), y: currentDisplay.bounds.y });
        currentAnimation = null;
        isAnimating = false;
        resolve();
      }
    };
    step();
  });
}

function isPointInsideWindow(point) {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  const bounds = mainWindow.getBounds();
  return point.x >= bounds.x && point.x <= bounds.x + bounds.width &&
         point.y >= bounds.y && point.y <= bounds.y + bounds.height;
}

function startGlobalMouseHook() {
  uIOhook.on('mousedown', (e) => {
    if (isAnimating) return;
    if (isExpanded && !fullscreenActive) {
      const clickPoint = { x: e.x, y: e.y };
      if (isPointInsideWindow(clickPoint)) return;
      if (notificationWindow && !notificationWindow.isDestroyed()) {
        const notifBounds = notificationWindow.getBounds();
        if (clickPoint.x >= notifBounds.x && clickPoint.x <= notifBounds.x + notifBounds.width &&
            clickPoint.y >= notifBounds.y && clickPoint.y <= notifBounds.y + notifBounds.height) {
          return;
        }
      }
      collapseIsland();
    }
  });
  uIOhook.start();
}

function stopGlobalMouseHook() {
  uIOhook.stop();
}

async function expandIsland() {
  if (isAnimating || isExpanded || fullscreenActive) return;
  mainWindow.webContents.send('hide-startup-overlay');
  try {
    const activeWindow = await activeWin.getActiveWindow();
    if (activeWindow && activeWindow.id !== mainWindow.id) previousActiveWindow = activeWindow;
  } catch (err) {}
  isExpanded = true;
  mainWindow.setAlwaysOnTop(true, 'screen-saver');
  const b = mainWindow.getBounds();
  mainWindow.webContents.executeJavaScript(`document.getElementById('island').classList.add('expanded')`);
  await animateResize(b.width, b.height, EXPANDED_WIDTH, EXPANDED_HEIGHT, 220);
  mainWindow.webContents.send('show-browser');
  startGlobalMouseHook();
}

async function collapseIsland() {
  if (isAnimating || !isExpanded || fullscreenActive) return;
  stopGlobalMouseHook();
  isExpanded = false;
  const b = mainWindow.getBounds();
  mainWindow.webContents.executeJavaScript(`document.getElementById('island').classList.remove('expanded')`);
  mainWindow.webContents.send('clear-search-reset');
  await animateResize(b.width, b.height, COLLAPSED_WIDTH, COLLAPSED_HEIGHT, 220);
  mainWindow.setAlwaysOnTop(true, 'screen-saver');
  mainWindow.blur();
  mainWindow.webContents.executeJavaScript(`
    if (document.getElementById('collapsedTime')) {
      document.getElementById('collapsedTime').classList.add('visible');
      document.getElementById('collapsedTime').style.display = '';
    }
  `);
  if (previousActiveWindow) {
    try { await activeWin.activateWindow(previousActiveWindow); } catch (err) {}
    previousActiveWindow = null;
  }
}

function moveIsland(direction) {
  dockPosition = direction;
  saveDockPosition();
  if (!mainWindow || mainWindow.isDestroyed()) return;
  updateCurrentDisplay();
  const bounds = mainWindow.getBounds();
  const x = getXForDock(bounds.width, direction, currentDisplay);
  mainWindow.setBounds({ width: bounds.width, height: bounds.height, x, y: currentDisplay.bounds.y });
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'Logo.ico'));
  tray = new Tray(icon);
  const menuTemplate = [
    { label: 'Запускать при запуске системы', type: 'checkbox', checked: appSettings.runAtStartup, click: (menuItem) => { setAutoLaunch(menuItem.checked); menuItem.checked = appSettings.runAtStartup; } },
    { label: 'Открывать по наведению', type: 'checkbox', checked: appSettings.hoverToOpen, click: (menuItem) => { setHoverToOpen(menuItem.checked); menuItem.checked = appSettings.hoverToOpen; } },
    { label: 'Анимация при запуске', type: 'checkbox', checked: appSettings.startupAnimationEnabled, click: (menuItem) => { appSettings.startupAnimationEnabled = menuItem.checked; saveSettings(); } },
    { type: 'separator' },
    { label: 'Обновить', click: performUpdate },
    { label: 'Обновлять при запуске', type: 'checkbox', checked: appSettings.autoUpdateEnabled, click: (menuItem) => { appSettings.autoUpdateEnabled = menuItem.checked; saveSettings(); } },
    { type: 'separator' },
    { label: 'Уведомления', type: 'checkbox', checked: notificationsEnabled, click: (menuItem) => { setNotificationsEnabled(menuItem.checked); menuItem.checked = notificationsEnabled; } },
    { type: 'separator' },
    { label: 'Перезапустить', click: () => { app.relaunch(); app.exit(); } },
    { type: 'separator' },
    { label: 'Переместить в:', submenu: [ { label: 'Право', click: () => moveIsland('right') }, { label: 'Лево', click: () => moveIsland('left') }, { label: 'Центр', click: () => moveIsland('center') } ] },
    { type: 'separator' },
    { label: 'Выход', click: () => { isQuitting = true; stopGlobalMouseHook(); app.quit(); } }
  ];
  const menu = Menu.buildFromTemplate(menuTemplate);
  tray.setContextMenu(menu);
  tray.setToolTip('Dynamic Island Browser');
  tray.on('click', () => { if (mainWindow.isVisible()) mainWindow.hide(); else mainWindow.show(); });
}

ipcMain.on('expand-island', expandIsland);
ipcMain.on('collapse-island', collapseIsland);
ipcMain.on('fullscreen-enter', () => {
  fullscreenActive = true;
  stopGlobalMouseHook();
  if (mainWindow && !mainWindow.isDestroyed()) { mainWindow.setAlwaysOnTop(false); mainWindow.setFullScreen(true); }
});
ipcMain.on('fullscreen-leave', async () => {
  fullscreenActive = false;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setFullScreen(false);
    mainWindow.setAlwaysOnTop(true, 'screen-saver');
    if (isExpanded) {
      const b = mainWindow.getBounds();
      await animateResize(b.width, b.height, EXPANDED_WIDTH, EXPANDED_HEIGHT, 220);
      startGlobalMouseHook();
    } else {
      const b = mainWindow.getBounds();
      await animateResize(b.width, b.height, COLLAPSED_WIDTH, COLLAPSED_HEIGHT, 220);
    }
  }
});
ipcMain.on('get-hover-mode', (event) => { event.returnValue = appSettings.hoverToOpen; });
ipcMain.on('get-saved-links', (event) => { event.returnValue = appSettings.savedLinks || []; });
ipcMain.on('save-saved-links', (event, links) => { appSettings.savedLinks = links; saveSettings(); });
ipcMain.on('close-notification', () => destroyNotification(false));
ipcMain.on('close-notification-animated', () => destroyNotification(true));

app.whenReady().then(async () => {
  if (process.platform === 'win32') app.setAppUserModelId('com.electron.dynamicbrowser');
  const cursorPoint = screen.getCursorScreenPoint();
  currentDisplay = screen.getDisplayNearestPoint(cursorPoint);
  loadDockPosition();
  loadSettings();
  if (appSettings.runAtStartup) setAutoLaunch(true);
  if (appSettings.autoUpdateEnabled) {
    await performUpdate();
  }
  let wallpaperPath = '';
  const bgPath = path.join(__dirname, 'Background.jpg');
  if (fs.existsSync(bgPath)) {
    wallpaperPath = bgPath;
  }
  createWindow(wallpaperPath);
  createTray();
  screen.on('display-metrics-changed', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    updateCurrentDisplay();
    const bounds = mainWindow.getBounds();
    const x = getXForDock(bounds.width, dockPosition, currentDisplay);
    mainWindow.setBounds({ x: x, y: currentDisplay.bounds.y });
  });
});

app.on('before-quit', () => {
  stopGlobalMouseHook();
  destroyNotification();
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
