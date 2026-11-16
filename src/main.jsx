import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import './index.css';
import App from './App.jsx';

// __HOSTED_BUILD__ is set by vite.config.js (npm run build:hosted).
if (!__HOSTED_BUILD__) await import('./fonts.js');

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
