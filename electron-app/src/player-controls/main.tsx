import React from 'react';
import ReactDOM from 'react-dom/client';
import { createPlayerBridge } from './bridge';
import { PlayerControlsApp } from './PlayerControlsApp';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('Player controls root was not found');

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <PlayerControlsApp bridge={createPlayerBridge()} />
  </React.StrictMode>,
);
