// Auto-update Squadron from its GitHub Releases.
//
// electron-updater checks the `publish` target configured in package.json (the
// RaihanStark/squadron GitHub repo), compares the latest published release to the
// running version, and — if a newer one exists — downloads the matching artifact
// in the background and installs it on the next quit. The update metadata
// (latest-linux.yml + the AppImage) is produced by electron-builder and attached
// to each release by the Release workflow.
//
// Notes:
//   - Auto-update only works in a packaged build. In dev (`npm run electron`) the
//     app isn't signed/packaged and electron-updater has no feed, so we no-op.
//   - electron-updater ships as CommonJS; under our ESM main process we pull the
//     `autoUpdater` singleton off the default export.
import electronUpdater from 'electron-updater'
import { app, dialog } from 'electron'

const { autoUpdater } = electronUpdater

// How often to re-check while the app stays open (every 6 hours), so long-running
// sessions still pick up releases without a restart.
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

let started = false

export function initAutoUpdater(win) {
  // Skip in development / unpackaged runs: there's nothing to update to and
  // electron-updater would throw on the missing app-update.yml.
  if (process.env.NODE_ENV === 'development' || !app.isPackaged) {
    return
  }
  if (started) return
  started = true

  // Download in the background; only prompt once an update is ready to install.
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('error', (err) => {
    // Network hiccups / no releases yet shouldn't crash the app — just log.
    console.error('[updater] error:', err?.message || err)
  })

  autoUpdater.on('update-available', (info) => {
    console.log('[updater] update available:', info?.version)
  })

  autoUpdater.on('update-not-available', () => {
    console.log('[updater] up to date')
  })

  autoUpdater.on('update-downloaded', async (info) => {
    console.log('[updater] update downloaded:', info?.version)
    const { response } = await dialog.showMessageBox(win, {
      type: 'info',
      buttons: ['Restart now', 'Later'],
      defaultId: 0,
      cancelId: 1,
      title: 'Update ready',
      message: `Squadron ${info?.version} has been downloaded.`,
      detail: 'Restart to apply the update. It will otherwise install the next time you quit.',
    })
    if (response === 0) autoUpdater.quitAndInstall()
  })

  const check = () => autoUpdater.checkForUpdates().catch((err) => {
    console.error('[updater] check failed:', err?.message || err)
  })

  check()
  setInterval(check, CHECK_INTERVAL_MS).unref()
}

export default initAutoUpdater
