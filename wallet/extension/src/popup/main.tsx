import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@/styles/globals.css';
import { BRAND } from '@/brand';
import { followTheme } from '@/lib/theme';
import { App } from './App';

document.title = BRAND;
// Light, dark, or the system's setting (Settings → Theme), before the first paint.
followTheme();

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
