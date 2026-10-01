import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './styles.css';
// The earlier "DevOS" layers in ./styles/ repaint every surface and break the Halo layout that
// replaced them, so they are kept for reference but no longer loaded.

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
