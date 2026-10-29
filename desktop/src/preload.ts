import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

// O que a página enxerga do app: só estas funções, sem Node nem Electron. O processo principal
// confere de onde veio cada pedido (servidor configurado ou páginas locais do app).
const version = process.argv.find((arg) => arg.startsWith('--harpia-version='))?.split('=')[1] ?? ''

contextBridge.exposeInMainWorld('harpiaDesktop', {
  platform: process.platform,
  version,
  setBadge: (count: number) => ipcRenderer.send('harpia:badge', count),
  notify: (notice: { title: string; body: string; taskId?: number | null }) => ipcRenderer.send('harpia:notify', notice),
  onOpenTask: (callback: (payload: { taskId: number }) => void) => {
    const listener = (_event: IpcRendererEvent, payload: { taskId: number }) => callback(payload)
    ipcRenderer.on('harpia:open-task', listener)
    return () => ipcRenderer.removeListener('harpia:open-task', listener)
  },
  // Páginas locais do app (endereço do servidor e "fora do ar").
  getServer: () => ipcRenderer.invoke('harpia:get-server') as Promise<string | null>,
  setServer: (url: string) => ipcRenderer.invoke('harpia:set-server', url) as Promise<{ ok: boolean; url?: string; error?: string }>,
  retry: () => ipcRenderer.send('harpia:retry'),
  changeServer: () => ipcRenderer.send('harpia:change-server')
})
