import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import '@fontsource-variable/plus-jakarta-sans/index.css'
import { IS_MAC } from './platform'
import './styles.css'

// The title bar leaves room for macOS traffic lights (left) or Windows/Linux window controls (right).
document.documentElement.dataset.platform = IS_MAC ? 'mac' : 'other'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
