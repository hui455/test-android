import { createRoot } from 'react-dom/client'
import './styles.css'
import { App } from './App'
import { Mini } from './Mini'
import { ServerApp } from './ServerApp'

const view = location.hash === '#mini' ? <Mini /> : location.hash === '#server' ? <ServerApp /> : <App />
createRoot(document.getElementById('root')!).render(view)
