import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
// Import Tailwind CSS - standalone version
import './globals.css';

// Fetch patch removed - we now use services directly
// Keeping this comment for reference - all API calls go through services now

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);



