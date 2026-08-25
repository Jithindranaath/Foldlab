import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './ui/App.tsx';
import './styles/tokens.css';
import './styles/glass.css';
import './styles/app.css';

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('Root element #root not found');

ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
