// Electron main process: start the Squadron backend on a free port (serving the
// built frontend from the same origin), then open a window onto it.
import { app, BrowserWindow, shell } from 'electron'
import path from 'node:path'
import net from 'node:net'
import { fileURLToPath } from 'node:url'
import { fixPath } from './fixPath.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// When launched from the OS GUI (Dock / app icon / .desktop), Electron inherits a
// bare PATH that omits the user's toolchain (npm, git, go, …). Restore the login
// shell's PATH up front so spawned preview/agent processes can find their tools.
fixPath()

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.unref()
    s.on('error', reject)
    s.listen(0, () => { const { port } = s.address(); s.close(() => resolve(port)) })
  })
}

async function startServer() {
  const port = await freePort()
  process.env.PORT = String(port)
  process.env.NODE_ENV = 'production'
  process.env.SQUADRON_SERVE_WEB = '1'
  const { started } = await import('../server/index.js')
  await started
  return port
}

function createWindow(port) {
  const win = new BrowserWindow({
    width: 1440, height: 920, minWidth: 900, minHeight: 600,
    backgroundColor: '#0d1117', title: 'Squadron',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true },
  })
  // Hide the native File/Edit/View menu bar on Linux/Windows. On macOS the menu
  // lives in the system bar and is left intact, so clipboard shortcuts
  // (Cmd+C/V/X/A) keep working in the chat textareas.
  win.setMenuBarVisibility(false)
  win.loadURL(`http://localhost:${port}`)
  // Open target=_blank / external links in the system browser, not a new window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  return win
}

app.whenReady().then(async () => {
  let port
  try {
    port = await startServer()
  } catch (e) {
    console.error('Failed to start Squadron backend:', e)
    app.quit()
    return
  }
  createWindow(port)
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(port) })
})

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
