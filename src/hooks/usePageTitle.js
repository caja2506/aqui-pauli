import { useEffect } from 'react';

// Recibe el título completo para que cada ruta pueda describir su contenido.
export default function usePageTitle(title) {
  useEffect(() => {
    if (typeof document === 'undefined') return undefined;
    const previousTitle = document.title;
    document.title = title;
    return () => { document.title = previousTitle; };
  }, [title]);
}
