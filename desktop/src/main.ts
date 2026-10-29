import { app, BrowserWindow, ipcMain, Menu, net, Notification, screen, session, shell, type IpcMainEvent, type IpcMainInvokeEvent, type MenuItemConstructorOptions } from 'electron'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { badgeCount, checkServerUrl, DEFAULT_SIZE, MIN_SIZE, navigationTarget, restoreBounds, type Bounds } from './rules.js'

// App de computador do Harpia: uma janela própria para o servidor da equipe (o mesmo do
// navegador). Não roda agentes nem guarda dados da equipe: só o endereço, a posição da janela e o
// login (no armazenamento da janela, como um navegador faria).

const STATIC = resolve(__dirname, '..', 'static')
const PARTITION = 'persist:harpia'
const ALLOWED_PERMISSIONS = new Set(['notifications', 'clipboard-sanitized-write', 'fullscreen'])

// Testes automatizados: dados isolados e servidor já escolhido.
if (process.env.HARPIA_DESKTOP_USER_DATA) app.setPath('userData', process.env.HARPIA_DESKTOP_USER_DATA)

interface Config {
  server: string | null
  bounds?: Bounds
  maximized?: boolean
}

const configPath = () => join(app.getPath('userData'), 'harpia-desktop.json')

function loadConfig(): Config {
  try {
    const saved = JSON.parse(readFileSync(configPath(), 'utf8')) as Config
    const server = saved.server ? checkServerUrl(saved.server) : null
    return { ...saved, server: server?.ok ? server.url : null }
  } catch {
    return { server: null }
  }
}

function saveConfig(): void {
  try {
    mkdirSync(dirname(configPath()), { recursive: true })
    writeFileSync(configPath(), JSON.stringify(config, null, 2))
  } catch {
    // Sem gravar a configuração, o app continua funcionando nesta sessão.
  }
}

let config: Config = { server: null }
let win: BrowserWindow | null = null

function isLocalPage(url: string | undefined): boolean {
  if (!url?.startsWith('file:')) return false
  try {
    return resolve(fileURLToPath(url)).startsWith(STATIC + sep)
  } catch {
    return false
  }
}

// Mensagens da página do servidor só valem do quadro principal e da origem configurada.
function fromServer(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  const frame = event.senderFrame
  return !!frame && frame === event.sender.mainFrame && navigationTarget(frame.url, config.server) === 'inside'
}

function fromLocalPage(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  const frame = event.senderFrame
  return !!frame && frame === event.sender.mainFrame && isLocalPage(frame.url)
}

function showSetup(): void {
  void win?.loadFile(join(STATIC, 'setup.html'))
}

function showOffline(reason: string): void {
  void win?.loadFile(join(STATIC, 'offline.html'), { query: { servidor: config.server ?? '', motivo: reason } })
}

function openServer(): void {
  if (!win) return
  if (!config.server) return showSetup()
  void win.loadURL(config.server)
}

function focusWindow(): void {
  if (!win) return createWindow()
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

function createWindow(): void {
  const bounds = restoreBounds(
    config.bounds,
    screen.getAllDisplays().map((display) => display.workArea)
  )
  win = new BrowserWindow({
    ...(bounds ?? DEFAULT_SIZE),
    minWidth: MIN_SIZE.width,
    minHeight: MIN_SIZE.height,
    show: false,
    title: 'Harpia',
    backgroundColor: '#0f1611',
    // No Mac, a barra do Harpia ocupa o topo, ao lado dos botões da janela.
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 14, y: 14 },
    icon: process.platform === 'darwin' ? undefined : join(STATIC, 'icon.png'),
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: true,
      partition: PARTITION,
      additionalArguments: [`--harpia-version=${app.getVersion()}`]
    }
  })
  if (config.maximized) win.maximize()
  win.once('ready-to-show', () => win?.show())
  win.on('close', () => {
    if (!win) return
    config.bounds = win.getNormalBounds()
    config.maximized = win.isMaximized()
    saveConfig()
  })
  win.on('closed', () => {
    win = null
  })
  win.on('focus', () => win?.flashFrame(false))

  const contents = win.webContents
  contents.setUserAgent(`${contents.getUserAgent()} HarpiaDesktop/${app.getVersion()}`)
  // Links que abririam uma janela nova: o servidor na própria janela, o resto no navegador.
  contents.setWindowOpenHandler(({ url }) => {
    const target = navigationTarget(url, config.server)
    if (target === 'browser') void shell.openExternal(url)
    if (target === 'inside') void contents.loadURL(url)
    return { action: 'deny' }
  })
  contents.on('will-navigate', (event, url) => {
    if (isLocalPage(url)) return
    const target = navigationTarget(url, config.server)
    if (target === 'inside') return
    event.preventDefault()
    if (target === 'browser') void shell.openExternal(url)
  })
  contents.on('will-redirect', (event, url) => {
    if (navigationTarget(url, config.server) !== 'inside' && !isLocalPage(url)) event.preventDefault()
  })
  // Servidor fora do ar (deploy, rede): uma página local que tenta de novo sozinha.
  contents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    if (!isMainFrame || code === -3 || isLocalPage(url)) return
    showOffline(description || `erro ${code}`)
  })
  contents.on('did-navigate', (_event, url, status) => {
    if (status >= 500 && navigationTarget(url, config.server) === 'inside') showOffline(`o servidor respondeu ${status}`)
  })
  openServer()
}

function buildMenu(): void {
  const mac = process.platform === 'darwin'
  const changeServer: MenuItemConstructorOptions = { label: 'Trocar de servidor…', click: showSetup }
  const template: MenuItemConstructorOptions[] = [
    ...(mac
      ? [
          {
            label: 'Harpia',
            submenu: [
              { role: 'about', label: 'Sobre o Harpia' },
              { type: 'separator' },
              changeServer,
              { type: 'separator' },
              { role: 'services', label: 'Serviços' },
              { type: 'separator' },
              { role: 'hide', label: 'Ocultar o Harpia' },
              { role: 'hideOthers', label: 'Ocultar os outros' },
              { role: 'unhide', label: 'Mostrar tudo' },
              { type: 'separator' },
              { role: 'quit', label: 'Sair do Harpia' }
            ]
          } satisfies MenuItemConstructorOptions
        ]
      : [{ label: 'Arquivo', submenu: [changeServer, { type: 'separator' }, { role: 'quit', label: 'Sair' }] } satisfies MenuItemConstructorOptions]),
    {
      label: 'Editar',
      submenu: [
        { role: 'undo', label: 'Desfazer' },
        { role: 'redo', label: 'Refazer' },
        { type: 'separator' },
        { role: 'cut', label: 'Recortar' },
        { role: 'copy', label: 'Copiar' },
        { role: 'paste', label: 'Colar' },
        { role: 'pasteAndMatchStyle', label: 'Colar sem formatação' },
        { role: 'selectAll', label: 'Selecionar tudo' }
      ]
    },
    {
      label: 'Ver',
      submenu: [
        { role: 'reload', label: 'Recarregar' },
        { role: 'forceReload', label: 'Recarregar sem cache' },
        { role: 'toggleDevTools', label: 'Ferramentas do desenvolvedor' },
        { type: 'separator' },
        { role: 'resetZoom', label: 'Tamanho original' },
        { role: 'zoomIn', label: 'Aumentar' },
        { role: 'zoomOut', label: 'Diminuir' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'Tela cheia' }
      ]
    },
    {
      label: 'Navegar',
      submenu: [
        { label: 'Voltar', accelerator: 'CmdOrCtrl+[', click: () => win?.webContents.navigationHistory.goBack() },
        { label: 'Avançar', accelerator: 'CmdOrCtrl+]', click: () => win?.webContents.navigationHistory.goForward() }
      ]
    },
    {
      label: 'Janela',
      submenu: mac
        ? [{ role: 'minimize', label: 'Minimizar' }, { role: 'zoom', label: 'Zoom' }, { type: 'separator' }, { role: 'front', label: 'Trazer tudo para a frente' }]
        : [{ role: 'minimize', label: 'Minimizar' }, { role: 'close', label: 'Fechar' }]
    },
    {
      label: 'Ajuda',
      submenu: [
        { label: 'Abrir no navegador', click: () => config.server && void shell.openExternal(config.server) },
        { label: 'Documentação do Harpia', click: () => void shell.openExternal('https://github.com/jeannnn19233-cyber/harpia#readme') }
      ]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function registerIpc(): void {
  // Contador no ícone: aprovações esperando a pessoa.
  ipcMain.on('harpia:badge', (event, value: unknown) => {
    if (!fromServer(event)) return
    app.setBadgeCount(badgeCount(value))
  })
  // Aviso do sistema quando a janela não está em foco; o clique abre a task.
  ipcMain.on('harpia:notify', (event, payload: unknown) => {
    if (!fromServer(event) || !Notification.isSupported()) return
    const data = (payload ?? {}) as { title?: unknown; body?: unknown; taskId?: unknown }
    const taskId = Number(data.taskId)
    const notice = new Notification({
      title: String(data.title ?? 'Harpia').slice(0, 120),
      body: String(data.body ?? '').slice(0, 300)
    })
    notice.on('click', () => {
      focusWindow()
      if (Number.isInteger(taskId) && taskId > 0) win?.webContents.send('harpia:open-task', { taskId })
    })
    notice.show()
    if (win && !win.isFocused()) win.flashFrame(true)
  })
  ipcMain.handle('harpia:get-server', (event) => (fromLocalPage(event) ? config.server : null))
  // Tela inicial: confere o endereço e se ali responde um Harpia antes de guardar.
  ipcMain.handle('harpia:set-server', async (event, input: unknown) => {
    if (!fromLocalPage(event)) return { ok: false, error: 'Pedido recusado.' }
    const checked = checkServerUrl(String(input ?? ''))
    if (!checked.ok) return checked
    try {
      const response = await net.fetch(`${checked.url}/api/health`, { signal: AbortSignal.timeout(10000) })
      if (!response.ok) return { ok: false, error: `O endereço respondeu ${response.status}: confira se é o Harpia da sua equipe.` }
    } catch {
      return { ok: false, error: 'Não consegui falar com esse endereço. Confira a internet e o endereço.' }
    }
    config.server = checked.url
    saveConfig()
    openServer()
    return checked
  })
  ipcMain.on('harpia:retry', (event) => fromLocalPage(event) && openServer())
  ipcMain.on('harpia:change-server', (event) => fromLocalPage(event) && showSetup())
}

function guardSession(): void {
  const harpia = session.fromPartition(PARTITION)
  const allowed = (permission: string, url: string | undefined) =>
    ALLOWED_PERMISSIONS.has(permission) && !!url && navigationTarget(url, config.server) === 'inside'
  harpia.setPermissionRequestHandler((_contents, permission, callback, details) => callback(allowed(permission, details.requestingUrl)))
  harpia.setPermissionCheckHandler((_contents, permission, origin) => allowed(permission, origin))
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', focusWindow)
  app.setAboutPanelOptions({ applicationName: 'Harpia', applicationVersion: app.getVersion(), copyright: 'Workspace da equipe com agentes de IA' })
  void app.whenReady().then(() => {
    config = loadConfig()
    const forced = process.env.HARPIA_DESKTOP_SERVER ? checkServerUrl(process.env.HARPIA_DESKTOP_SERVER) : null
    if (forced?.ok) config.server = forced.url
    guardSession()
    registerIpc()
    buildMenu()
    createWindow()
    app.on('activate', () => {
      if (!win) createWindow()
    })
  })
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
