import { useEffect, useState } from 'react'
import type { User } from '../../shared/types.ts'
import { InviteScreen, LoginScreen, SetupScreen } from './components/AuthScreens.tsx'
import { Workspace } from './components/Workspace.tsx'
import { api, ApiError } from './lib/api.ts'
import { useHarpia } from './lib/store.ts'

type Screen = 'loading' | 'setup' | 'login' | 'invite' | 'workspace' | 'offline'

function inviteToken(): string | null {
  const match = location.pathname.match(/^\/convite\/([A-Za-z0-9_-]+)$/)
  return match ? match[1] : null
}

export function App() {
  const setMe = useHarpia((state) => state.setMe)
  const [screen, setScreen] = useState<Screen>('loading')
  const [setupCodeRequired, setSetupCodeRequired] = useState(false)
  const token = inviteToken()

  const enter = (user: User) => {
    setMe(user)
    setScreen('workspace')
  }

  useEffect(() => {
    const load = async () => {
      try {
        const status = await api.status()
        setSetupCodeRequired(status.setupCodeRequired)
        if (status.needsSetup) return setScreen('setup')
        if (token) return setScreen('invite')
        enter((await api.me()).user)
      } catch (err) {
        setScreen(err instanceof ApiError && err.status === 401 ? 'login' : 'offline')
      }
    }
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const logout = async () => {
    await api.logout().catch(() => undefined)
    location.href = '/'
  }

  switch (screen) {
    case 'loading':
      return <div className="flex h-full items-center justify-center text-sm text-zinc-500">Carregando…</div>
    case 'offline':
      return (
        <div className="flex h-full items-center justify-center text-sm text-zinc-400">
          Não foi possível falar com o servidor do Harpia. Verifique se ele está rodando e recarregue a página.
        </div>
      )
    case 'setup':
      return <SetupScreen askSetupCode={setupCodeRequired} onDone={enter} />
    case 'invite':
      return <InviteScreen token={token ?? ''} onDone={enter} />
    case 'login':
      return <LoginScreen onDone={enter} />
    case 'workspace':
      return <Workspace onLogout={() => void logout()} />
  }
}
