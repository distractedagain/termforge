import { resolveColorScheme } from '../app/color-schemes.cjs';
import './appearance.css';

const chromeKeys = Object.keys(resolveColorScheme().chrome);

export function applyInterfaceColors(settings) {
  const root = document.documentElement;
  const scheme = resolveColorScheme(settings.colorScheme);
  const match = settings.matchColorScheme === true;
  root.dataset.matchColors = String(match);
  root.dataset.theme = match ? scheme.appearance : settings.theme;
  // Remove every override when matching is disabled so the platform's normal
  // light/dark styles resume, including its native control color scheme.
  for (const key of chromeKeys) {
    if (match) root.style.setProperty(key, scheme.chrome[key]);
    else root.style.removeProperty(key);
  }
  root.style.setProperty('--terminal-background', scheme.theme.background);
  root.style.setProperty('--terminal-foreground', scheme.theme.foreground);
  root.style.setProperty('--terminal-selection', scheme.theme.selectionBackground);
  root.style.setProperty('--terminal-selection-text', scheme.theme.selectionForeground);
  document.getElementById('welcome').dataset.colorScheme = scheme.id;
}

export function applyTerminalColors(connection, globalScheme) {
  const scheme = resolveColorScheme(connection.profile.terminal?.colorScheme, globalScheme);
  connection.pane.dataset.colorScheme = scheme.id;
  connection.pane.style.setProperty('--terminal-background', scheme.theme.background);
}
