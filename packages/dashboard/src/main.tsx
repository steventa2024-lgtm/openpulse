import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './styles.css';
import './styles/devos-overrides.css';
import './styles/devos-polish.css';
import './styles/devos-pro.css';
import './styles/devos-big.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
