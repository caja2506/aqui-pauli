import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import { AuthProvider } from './contexts/AuthContext'
import { RoleProvider } from './contexts/RoleContext'
import { CartProvider } from './contexts/CartContext'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <AuthProvider>
      <RoleProvider>
        <CartProvider>
          <App />
        </CartProvider>
      </RoleProvider>
    </AuthProvider>
  </StrictMode>,
)

// Si el navegador sirvió un index.html viejo (caché), detectamos el bundle nuevo y recargamos una vez
if (import.meta.env.PROD) {
  const current = [...document.scripts].map((x) => x.src).find((u) => /\/assets\/index-[^/]+\.js/.test(u));
  if (current && !sessionStorage.getItem('aqp_reloaded')) {
    fetch('/index.html', { cache: 'no-store' })
      .then((r) => r.text())
      .then((html) => {
        const latest = (html.match(/\/assets\/index-[^"']+\.js/) || [])[0];
        if (latest && !current.endsWith(latest)) {
          sessionStorage.setItem('aqp_reloaded', '1');
          location.reload();
        }
      })
      .catch(() => {});
  }
}
