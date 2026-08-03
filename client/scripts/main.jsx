import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import { applyTheme, theme } from './theme.js';

// Publish the palette as CSS custom properties before the first render, so the
// stylesheets and the canvas are drawing from the same theme.
applyTheme();
document.body.style.backgroundColor = theme.page.background;
document.body.style.color = theme.page.text;

ReactDOM.createRoot(document.getElementById('root')).render(<App />);