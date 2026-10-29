import { createRoot } from 'react-dom/client'
import './styles.css'
import { App } from './App'
import { Mini } from './Mini'

createRoot(document.getElementById('root')!).render(location.hash === '#mini' ? <Mini /> : <App />)
