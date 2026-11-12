import { createRoot } from 'react-dom/client';
import '../../../src/app/globals.css';
import { Harness } from './Harness';

/** TEST HARNESS ONLY: standalone mount for an esbuild bundle (see tests/ui/README.md). */
const q = new URLSearchParams(location.search);
document.documentElement.dataset.theme = q.get('theme') === 'dark' ? 'dark' : 'light';
document.documentElement.dir = q.get('lang') === 'ar' ? 'rtl' : 'ltr';
document.documentElement.lang = q.get('lang') === 'ar' ? 'ar' : 'en';
const el = document.getElementById('root');
if (el) createRoot(el).render(<Harness search={location.search} />);
