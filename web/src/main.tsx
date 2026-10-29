import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.tsx'
import { markDesktop } from './lib/desktop.ts'
import './index.css'

markDesktop()

const root = document.getElementById('root')
if (!root) throw new Error('Elemento #root não encontrado.')

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
)
