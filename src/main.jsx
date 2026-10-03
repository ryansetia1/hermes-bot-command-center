import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { PresenceProvider } from './PresenceProvider.jsx'
import App from './App.jsx'
import './styles.css'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <PresenceProvider><App /></PresenceProvider>
  </StrictMode>,
)
