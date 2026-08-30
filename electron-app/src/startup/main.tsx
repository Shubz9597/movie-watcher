import ReactDOM from 'react-dom/client';
import { createStartupApi } from './bridge';
import { StartupApp } from './StartupApp';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('Startup root was not found');

ReactDOM.createRoot(root).render(<StartupApp api={createStartupApi()} />);
