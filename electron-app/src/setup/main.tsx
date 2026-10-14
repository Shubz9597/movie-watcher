import ReactDOM from 'react-dom/client';
import { createSetupApi } from './bridge';
import { DesktopConnectionSetup } from './DesktopConnectionSetup';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('Setup root was not found');

ReactDOM.createRoot(root).render(<DesktopConnectionSetup api={createSetupApi()} />);
