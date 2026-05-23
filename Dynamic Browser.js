const { app, BrowserWindow, screen, ipcMain, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const activeWin = require('active-win');
const { uIOhook, UiohookMouseEvent } = require('uiohook-napi');

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
}

let mainWindow;
let tray = null;
let isExpanded = false;
let currentAnimation = null;
let fullscreenActive = false;
let dockPosition = 'center';
let isQuitting = false;
let previousActiveWindow = null;
let currentDisplay = null;
let isAnimating = false;

const configPath = path.join(app.getPath('userData'), 'dock-position.json');
const settingsPath = path.join(app.getPath('userData'), 'app-settings.json');
let appSettings = { runAtStartup: false, hoverToOpen: false, savedLinks: [] };
const COLLAPSED_WIDTH = 180;
const COLLAPSED_HEIGHT = 36;
const EXPANDED_WIDTH = 800;
const EXPANDED_HEIGHT = 520;

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
    appSettings = { runAtStartup: false, hoverToOpen: false, savedLinks: [] };
  }
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

function createWindow() {
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

  const html = `
  <!DOCTYPE html>
  <html style="margin:0;padding:0;background:transparent;">
  <head>
    <meta charset="UTF-8">
    <style>
      @import url('https://fonts.googleapis.com/css2?family=Inter:opsz,wght@14..32,400;14..32,500;14..32,600;14..32,700&display=swap');
      * { margin: 0; padding: 0; box-sizing: border-box; user-select: none; }
      html, body { width: 100%; height: 100%; background: transparent; overflow: hidden; }
      body { display: flex; align-items: center; justify-content: center; cursor: pointer; font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
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
      .dynamic-island:hover {
        background: #111111;
      }
      .dynamic-island.expanded {
        border-bottom-left-radius: 20px;
        border-bottom-right-radius: 20px;
      }
      .browser-container {
        width: 100%; height: 100%; opacity: 0; transition: opacity 0.2s ease;
        display: flex; flex-direction: column; min-width: 0; min-height: 0; position: relative;
      }
      .expanded .browser-container { opacity: 1; }
      .tabs-bar {
        display: flex; align-items: stretch; padding: 6px 8px 0 8px; background: #111111;
        border-bottom: 0.5px solid #222222; flex-shrink: 0; min-height: 32px;
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
      }
      .nav-btn {
        background: #1a1a1a; border: 0.5px solid #333333;
        border-radius: 24px; padding: 5px 10px; font-family: 'Inter', sans-serif; font-size: 13px;
        color: white; cursor: pointer; transition: 0.15s; min-width: 32px; text-align: center;
        font-weight: 500;
      }
      .nav-btn:hover { background: #2a5a9a; transform: scale(0.97); }
      .url-input-wrapper {
        flex: 1; min-width: 0; display: flex; align-items: center;
        background: #0a0a0a; border: 0.5px solid #333333; border-radius: 32px;
        padding: 0 12px; transition: background 0.15s, border-color 0.15s, box-shadow 0.15s;
      }
      .url-input-wrapper:focus-within {
        background: #151515; border-color: #4a8ad0;
        box-shadow: 0 0 6px rgba(70, 150, 255, 0.3);
      }
      .url-input-wrapper .security-icon {
        font-size: 16px; margin-right: 6px; line-height: 1; flex-shrink: 0;
      }
      .url-input-wrapper .url-input {
        flex: 1; min-width: 0; background: transparent; border: none; outline: none;
        font-family: 'Inter', sans-serif; font-size: 13px; color: white; font-weight: 500;
        padding: 6px 0;
      }
      .menu-btn {
        background: #1a1a1a; border: 0.5px solid #333333;
        border-radius: 24px; padding: 5px 10px; font-family: 'Inter', sans-serif; font-size: 16px;
        color: white; cursor: pointer; transition: 0.15s; min-width: 32px; text-align: center;
        font-weight: 500; position: relative;
      }
      .menu-btn:hover { background: #2a5a9a; }
      .menu-dropdown {
        position: absolute; right: 8px; top: 100%; margin-top: 4px;
        background: #1a1a1a; border: 0.5px solid #333333; border-radius: 12px;
        min-width: 260px; padding: 8px; z-index: 200; flex-direction: column;
        box-shadow: 0 4px 12px rgba(0,0,0,0.5);
        opacity: 0; transform: translateY(-8px); pointer-events: none;
        transition: opacity 0.2s cubic-bezier(0.2, 0.9, 0.4, 1.1), transform 0.2s cubic-bezier(0.2, 0.9, 0.4, 1.1);
        display: flex;
      }
      .menu-dropdown.active {
        opacity: 1; transform: translateY(0); pointer-events: auto;
      }
      .menu-dropdown .add-link-area {
        display: flex; gap: 4px; margin-bottom: 8px; align-items: center;
      }
      .menu-dropdown .add-link-input {
        flex: 1; background: #0a0a0a; border: 0.5px solid #333333; border-radius: 16px;
        padding: 4px 10px; font-family: 'Inter', sans-serif; font-size: 12px; color: white; outline: none;
      }
      .menu-dropdown .add-link-btn {
        background: #2a5a9a; border: none; border-radius: 16px; color: white; padding: 4px 10px;
        font-weight: bold; cursor: pointer; font-size: 18px; line-height: 1;
      }
      .menu-dropdown .save-current-btn {
        background: #1a1a1a; border: 0.5px solid #333333; border-radius: 16px;
        color: white; padding: 4px 8px; font-size: 14px; cursor: pointer; line-height: 1;
        display: flex; align-items: center; justify-content: center;
      }
      .menu-dropdown .save-current-btn:hover { background: #2a5a9a; }
      .menu-dropdown .saved-links-list {
        list-style: none; max-height: 200px; overflow-y: auto;
      }
      .saved-links-list::-webkit-scrollbar { width: 6px; }
      .saved-links-list::-webkit-scrollbar-track { background: transparent; }
      .saved-links-list::-webkit-scrollbar-thumb { background: #444; border-radius: 3px; }
      .saved-links-list::-webkit-scrollbar-thumb:hover { background: #555; }
      .menu-dropdown .saved-link-item {
        display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: 8px;
        cursor: pointer; font-size: 13px; color: white; position: relative;
      }
      .menu-dropdown .saved-link-item:hover { background: #333333; }
      .menu-dropdown .saved-link-favicon {
        width: 16px; height: 16px; border-radius: 2px; object-fit: contain; flex-shrink: 0;
      }
      .menu-dropdown .saved-link-title {
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
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
      .webview-container { flex: 1; position: relative; background: #000000; }
      webview { position: absolute; top: 0; left: 0; width: 100%; height: 100%; background: #000000; }
    </style>
  </head>
  <body>
    <div class="dynamic-island" id="island">
      <div class="browser-container" id="browserContainer" style="display: none;">
        <div class="tabs-bar" id="tabsBar">
          <div class="tabs-scroll" id="tabsScroll"></div>
          <div class="add-tab" id="addTabBtn">+</div>
        </div>
        <div class="nav-area">
          <button class="nav-btn" id="backBtn">◀</button>
          <button class="nav-btn" id="forwardBtn">▶</button>
          <button class="nav-btn" id="reloadBtn">⟳</button>
          <div class="url-input-wrapper" id="urlInputWrapper">
            <span id="securityIcon" class="security-icon"></span>
            <input type="text" class="url-input" id="urlInput" placeholder="URL или поиск">
          </div>
          <div style="position:relative;">
            <button class="menu-btn" id="menuBtn">⋮</button>
            <div class="menu-dropdown" id="menuDropdown">
              <div class="add-link-area">
                <input type="text" class="add-link-input" id="addLinkInput" placeholder="URL для сохранения">
                <button class="add-link-btn" id="addLinkBtn">+</button>
                <button class="save-current-btn" id="saveCurrentBtn" title="Сохранить текущую страницу">📌</button>
              </div>
              <ul class="saved-links-list" id="savedLinksList"></ul>
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
      const menuBtn = document.getElementById('menuBtn');
      const menuDropdown = document.getElementById('menuDropdown');
      const addLinkInput = document.getElementById('addLinkInput');
      const addLinkBtn = document.getElementById('addLinkBtn');
      const saveCurrentBtn = document.getElementById('saveCurrentBtn');
      const savedLinksList = document.getElementById('savedLinksList');
      const contextMenu = document.getElementById('contextMenu');
      const ctxCopy = document.getElementById('ctxCopy');
      const ctxDelete = document.getElementById('ctxDelete');
      const confirmModal = document.getElementById('confirmModal');
      const modalYes = document.getElementById('modalYes');
      const modalNo = document.getElementById('modalNo');

      let tabs = [];
      let activeTabId = null;
      let nextTabId = 1;
      let hoverModeEnabled = false;
      let savedLinks = [];
      let currentContextLink = null;

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

      function getFaviconUrl(url) {
        const hostname = getHostnameFromUrl(url);
        return 'https://www.google.com/s2/favicons?domain=' + hostname;
      }

      function normalizeLinkObject(item) {
        if (typeof item === 'string') {
          const hostname = getHostnameFromUrl(item);
          return { url: item, title: hostname, favicon: getFaviconUrl(item) };
        }
        if (!item.title) item.title = getHostnameFromUrl(item.url);
        if (!item.favicon) item.favicon = getFaviconUrl(item.url);
        return item;
      }

      function loadSavedLinks() {
        savedLinks = ipcRenderer.sendSync('get-saved-links').map(normalizeLinkObject);
        renderSavedLinks();
      }

      function saveLinksToStorage() {
        ipcRenderer.send('save-saved-links', savedLinks);
      }

      function showNoInternetMessage(webview, failedUrl) {
        const escapedUrl = failedUrl.replace(/'/g, "\\\\'");
        const errorHtml = \`<html style="background:#000000; color:white; display:flex; align-items:center; justify-content:center; height:100%; font-family:'Inter',sans-serif;"><body style="text-align:center; margin:0;"><div style="padding:20px;"><div style="font-size:48px; margin-bottom:16px;">🌐</div><div style="font-size:18px; font-weight:600; margin-bottom:8px;">Нет подключения к интернету</div><div style="font-size:14px; color:#aaa;">Проверьте соединение и попробуйте снова</div><button onclick="location.href='\${escapedUrl}'" style="margin-top:20px; padding:8px 20px; background:#2a5a9a; border:none; border-radius:20px; color:white; cursor:pointer; font-family:'Inter',sans-serif; font-weight:500;">Повторить</button></div></body></html>\`;
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
        if (!activeTab) return;
        const urlToShow = (activeTab.displayUrl && !isErrorPage(activeTab.displayUrl)) 
          ? activeTab.displayUrl 
          : (activeTab.originalUrl || '');
        urlInput.value = urlToShow;
        updateSecurityIcon(urlToShow);
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
            showNoInternetMessage(webview, failed);
          }
        });
        webview.addEventListener('did-start-loading', () => {
          const tab = tabs.find(t => t.id === id);
          if (tab && activeTabId === id) reloadBtn.textContent = '⛔';
        });
        webview.addEventListener('did-navigate', () => {
          const tab = tabs.find(t => t.id === id);
          if (tab && activeTabId === id) { tab.displayUrl = webview.src; updateUrlInput(); }
        });
        webview.addEventListener('did-navigate-in-page', () => {
          const tab = tabs.find(t => t.id === id);
          if (tab && activeTabId === id) { tab.displayUrl = webview.src; updateUrlInput(); }
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
          if (tab && activeTabId === id) {
            reloadBtn.textContent = '⟳';
            tab.displayUrl = webview.src;
            updateUrlInput();
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
        closeSpan.addEventListener('click', (e) => { e.stopPropagation(); closeTabWithAnimation(tab.id); });
        tabEl.appendChild(img);
        tabEl.appendChild(titleSpan);
        tabEl.appendChild(closeSpan);
        tabEl.addEventListener('click', () => switchToTab(tab.id));
        tab.element = tabEl;
        return tabEl;
      }

      function addTab(url, activate = true) {
        if (!canAddTab()) return false;
        const id = nextTabId++;
        const webview = createWebview(url, id);
        webview.setAttribute('data-id', id);
        webviewContainer.appendChild(webview);
        const newTab = { id, title: 'Загрузка...', favicon: '', originalUrl: url || 'https://www.google.com', displayUrl: url || 'https://www.google.com', webview, element: null };
        tabs.push(newTab);
        const tabEl = createTabElement(newTab);
        tabsScroll.appendChild(tabEl);
        if (activate) {
          tabEl.classList.add('active');
          webview.style.display = 'flex';
          if (activeTabId !== null) {
            const prevTab = tabs.find(t => t.id === activeTabId);
            if (prevTab && prevTab.element) prevTab.element.classList.remove('active');
            const prevWebview = prevTab?.webview;
            if (prevWebview) prevWebview.style.display = 'none';
          }
          activeTabId = id;
          updateUrlInput();
          reloadBtn.textContent = webview.isLoading() ? '⛔' : '⟳';
        } else {
          webview.style.display = 'none';
        }
        tabEl.classList.add('tab-adding');
        tabEl.addEventListener('animationend', () => tabEl.classList.remove('tab-adding'), { once: true });
        return true;
      }

      function switchToTab(id) {
        const tab = tabs.find(t => t.id === id);
        if (!tab) return;
        if (activeTabId !== null) {
          const prevTab = tabs.find(t => t.id === activeTabId);
          if (prevTab && prevTab.element) prevTab.element.classList.remove('active');
          if (prevTab && prevTab.webview) prevTab.webview.style.display = 'none';
        }
        activeTabId = id;
        if (tab.element) tab.element.classList.add('active');
        if (tab.webview) tab.webview.style.display = 'flex';
        const activeWebview = tab.webview;
        if (activeWebview) {
          const urlToShow = (tab.displayUrl && !isErrorPage(tab.displayUrl)) ? tab.displayUrl : (tab.originalUrl || '');
          urlInput.value = urlToShow;
          updateSecurityIcon(urlToShow);
          reloadBtn.textContent = activeWebview.isLoading() ? '⛔' : '⟳';
        }
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
        if (tabs.length === 0) addTab('https://www.google.com', true);
        else if (activeTabId === id) switchToTab(tabs[Math.min(index, tabs.length - 1)].id);
      }

      function isGoogleHomepage(url) {
        return url === 'https://www.google.com' || url === 'https://www.google.com/';
      }

      function renderSavedLinks() {
        if (!savedLinksList) return;
        savedLinksList.innerHTML = '';
        savedLinks.forEach((linkObj) => {
          const li = document.createElement('li');
          li.className = 'saved-link-item';
          li.dataset.url = linkObj.url;
          const img = document.createElement('img');
          img.className = 'saved-link-favicon';
          img.src = linkObj.favicon || '';
          img.onerror = () => { img.style.display = 'none'; };
          const titleSpan = document.createElement('span');
          titleSpan.className = 'saved-link-title';
          titleSpan.textContent = linkObj.title || getHostnameFromUrl(linkObj.url);
          li.appendChild(img);
          li.appendChild(titleSpan);
          li.addEventListener('click', (e) => {
            e.stopPropagation();
            menuDropdown.classList.remove('active');
            const normalized = normalizeUrl(linkObj.url);
            if (!normalized) return;
            const activeTab = tabs.find(t => t.id === activeTabId);
            const currentUrl = activeTab ? (activeTab.displayUrl || activeTab.originalUrl) : '';
            if (activeTab && isGoogleHomepage(currentUrl)) {
              activeTab.webview.src = normalized;
              activeTab.originalUrl = normalized;
            } else {
              addTab(normalized, true);
            }
          });
          li.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
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
          savedLinksList.appendChild(li);
        });
      }

      function hideContextMenu() { contextMenu.classList.remove('active'); }
      function showConfirmModal() { confirmModal.classList.add('active'); }
      function hideConfirmModal() { confirmModal.classList.remove('active'); currentContextLink = null; }

      ctxCopy.addEventListener('click', () => {
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
        if (currentContextLink) showConfirmModal();
        hideContextMenu();
      });

      modalYes.addEventListener('click', () => {
        if (currentContextLink) {
          savedLinks = savedLinks.filter(l => l.url !== currentContextLink.url);
          saveLinksToStorage();
          renderSavedLinks();
        }
        hideConfirmModal();
      });

      modalNo.addEventListener('click', hideConfirmModal);
      confirmModal.addEventListener('click', (e) => { if (e.target === confirmModal) hideConfirmModal(); });

      document.addEventListener('click', (e) => { if (!contextMenu.contains(e.target)) hideContextMenu(); });

      async function fetchSiteInfo(url) {
        try {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 5000);
          const response = await fetch(url, { signal: controller.signal });
          clearTimeout(timeoutId);
          if (!response.ok) throw new Error('Status ' + response.status);
          const html = await response.text();
          const parser = new DOMParser();
          const doc = parser.parseFromString(html, 'text/html');
          let title = doc.title || getHostnameFromUrl(url);
          let favicon = '';
          const iconLink = doc.querySelector('link[rel="icon"], link[rel="shortcut icon"]');
          if (iconLink) {
            favicon = iconLink.getAttribute('href');
            if (favicon && !favicon.startsWith('http')) {
              favicon = new URL(favicon, url).href;
            }
          }
          if (!favicon) favicon = getFaviconUrl(url);
          return { title, favicon };
        } catch (e) {
          return { title: getHostnameFromUrl(url), favicon: getFaviconUrl(url) };
        }
      }

      function updateSavedLinkData(existingLink, newData) {
        existingLink.title = newData.title;
        existingLink.favicon = newData.favicon;
        saveLinksToStorage();
        renderSavedLinks();
      }

      async function addLinkFromInput() {
        const rawUrl = addLinkInput.value.trim();
        if (!rawUrl) return;
        const normalized = normalizeUrl(rawUrl) || rawUrl;
        const existing = savedLinks.find(l => l.url === normalized);
        if (existing) {
          const info = await fetchSiteInfo(normalized);
          updateSavedLinkData(existing, info);
          addLinkInput.value = '';
          return;
        }
        const tempObj = { url: normalized, title: 'Загрузка...', favicon: '' };
        savedLinks.push(tempObj);
        saveLinksToStorage();
        renderSavedLinks();
        addLinkInput.value = '';
        const info = await fetchSiteInfo(normalized);
        Object.assign(tempObj, info);
        saveLinksToStorage();
        renderSavedLinks();
      }

      addLinkBtn.addEventListener('click', addLinkFromInput);
      addLinkInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') addLinkFromInput(); });

      saveCurrentBtn.addEventListener('click', () => {
        const activeTab = tabs.find(t => t.id === activeTabId);
        if (activeTab) {
          const url = activeTab.displayUrl || activeTab.originalUrl;
          if (url && !url.startsWith('data:') && !url.startsWith('javascript:') && url !== 'about:blank') {
            const existing = savedLinks.find(l => l.url === url);
            if (existing) {
              existing.title = activeTab.title || getHostnameFromUrl(url);
              existing.favicon = activeTab.favicon || getFaviconUrl(url);
              saveLinksToStorage();
              renderSavedLinks();
            } else {
              savedLinks.push({
                url: url,
                title: activeTab.title || getHostnameFromUrl(url),
                favicon: activeTab.favicon || getFaviconUrl(url)
              });
              saveLinksToStorage();
              renderSavedLinks();
            }
          }
        }
      });

      menuBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        menuDropdown.classList.toggle('active');
      });

      document.addEventListener('click', (e) => {
        if (!menuDropdown.contains(e.target) && e.target !== menuBtn) {
          menuDropdown.classList.remove('active');
        }
      });

      ipcRenderer.on('open-new-tab', (e, url) => {
        if (url && url !== 'about:blank' && !url.startsWith('javascript:')) addTab(url, true);
      });

      backBtn.addEventListener('click', () => {
        const tab = tabs.find(t => t.id === activeTabId);
        if (tab && tab.webview && tab.webview.canGoBack()) tab.webview.goBack();
      });
      forwardBtn.addEventListener('click', () => {
        const tab = tabs.find(t => t.id === activeTabId);
        if (tab && tab.webview && tab.webview.canGoForward()) tab.webview.goForward();
      });
      reloadBtn.addEventListener('click', () => {
        const tab = tabs.find(t => t.id === activeTabId);
        if (tab && tab.webview) {
          if (tab.webview.isLoading()) tab.webview.stop();
          else tab.webview.reload();
        }
      });
      urlInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
          const url = normalizeUrl(urlInput.value);
          if (url) {
            const tab = tabs.find(t => t.id === activeTabId);
            if (tab && tab.webview) {
              tab.webview.src = url;
              tab.originalUrl = url;
            }
          }
        }
      });
      addTabBtn.addEventListener('click', () => addTab('https://www.google.com', true));

      window.addEventListener('online', () => reloadAllErrorPages());
      window.addEventListener('resize', () => { if (tabs.length === 0) addTab('https://www.google.com', true); });

      ipcRenderer.on('hover-mode-changed', (event, enabled) => { hoverModeEnabled = enabled; });
      hoverModeEnabled = ipcRenderer.sendSync('get-hover-mode');

      island.addEventListener('mouseenter', () => {
        if (hoverModeEnabled && !island.classList.contains('expanded')) ipcRenderer.send('expand-island');
      });

      island.addEventListener('click', e => {
        if (e.target === urlInput || e.target === backBtn || e.target === forwardBtn || e.target === reloadBtn || e.target.closest('.tab') || e.target === addTabBtn || e.target.closest('.add-tab') || e.target === menuBtn || menuDropdown.contains(e.target) || e.target.closest('.url-input-wrapper')) return;
        e.stopPropagation();
        if (!island.classList.contains('expanded') && !hoverModeEnabled) ipcRenderer.send('expand-island');
      });

      ipcRenderer.on('clear-search-reset', () => { browserContainer.style.display = 'none'; });
      ipcRenderer.on('show-browser', () => {
        browserContainer.style.display = 'flex';
        if (tabs.length === 0) addTab('https://www.google.com', true);
        else if (activeTabId === null && tabs.length) switchToTab(tabs[0].id);
        loadSavedLinks();
      });

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
      if (!isPointInsideWindow(clickPoint)) {
        collapseIsland();
      }
    }
  });
  uIOhook.start();
}

function stopGlobalMouseHook() {
  uIOhook.stop();
}

async function expandIsland() {
  if (isAnimating || isExpanded || fullscreenActive) return;
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

app.whenReady().then(() => {
  if (process.platform === 'win32') app.setAppUserModelId('com.electron.dynamicbrowser');
  const cursorPoint = screen.getCursorScreenPoint();
  currentDisplay = screen.getDisplayNearestPoint(cursorPoint);
  loadDockPosition();
  loadSettings();
  if (appSettings.runAtStartup) setAutoLaunch(true);
  createWindow();
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
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
