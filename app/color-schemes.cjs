'use strict';

// This catalogue is shared by the Node configuration validator and the browser
// renderer. Keep it free of platform APIs so every saved ID has one definition.
const DEFAULT_COLOR_SCHEME = 'traditional';
const ANSI_COLOR_KEYS = Object.freeze([
  'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite',
]);

function palette(id, name, description, appearance, terminal, ansi, chrome) {
  const theme = Object.freeze({
    ...terminal,
    selectionInactiveBackground: terminal.selectionBackground,
    ...Object.fromEntries(ANSI_COLOR_KEYS.map((key, index) => [key, ansi[index]])),
  });
  return Object.freeze({ id, name, description, appearance, theme, chrome: Object.freeze({ ...chrome, '--terminal': theme.background }) });
}

// Solarized sRGB values and ANSI slots follow Ethan Schoonover's canonical
// table: https://ethanschoonover.com/solarized/#the-values
// Both variants intentionally share the ANSI table. Programs that use ANSI
// slots as named Solarized base colors rely on this exact mapping.
const solarizedAnsi = [
  '#073642', '#dc322f', '#859900', '#b58900', '#268bd2', '#d33682', '#2aa198', '#eee8d5',
  '#002b36', '#cb4b16', '#586e75', '#657b83', '#839496', '#6c71c4', '#93a1a1', '#fdf6e3',
];

const COLOR_SCHEMES = Object.freeze([
  palette('traditional', 'Traditional', 'Classic silver text on black with familiar ANSI colors.', 'dark', {
    background: '#000000', foreground: '#c0c0c0', cursor: '#c0c0c0', cursorAccent: '#000000',
    selectionBackground: '#375675', selectionForeground: '#ffffff',
  }, [
    '#000000', '#b94343', '#48a848', '#b8a841', '#4477bb', '#a653a6', '#43a6a6', '#c0c0c0',
    '#777777', '#ef7676', '#75d475', '#e1d571', '#7c9fdf', '#d78dd7', '#8bdada', '#ffffff',
  ], {
    '--chrome': '#303030', '--panel': '#262626', '--field': '#1e1e1e', '--border': '#666666', '--border-soft': '#444444',
    '--text': '#ededed', '--muted': '#aaaaaa', '--hover': '#3b4c5c', '--select': '#244b71', '--accent': '#7fb6eb',
  }),
  palette('monochrome', 'Monochrome', 'Neutral grayscale for text without colored ANSI accents.', 'dark', {
    background: '#000000', foreground: '#e4e4e4', cursor: '#ffffff', cursorAccent: '#000000',
    selectionBackground: '#505050', selectionForeground: '#ffffff',
  }, [
    '#000000', '#c0c0c0', '#c0c0c0', '#c0c0c0', '#c0c0c0', '#c0c0c0', '#c0c0c0', '#c0c0c0',
    '#777777', '#ffffff', '#ffffff', '#ffffff', '#ffffff', '#ffffff', '#ffffff', '#ffffff',
  ], {
    '--chrome': '#292929', '--panel': '#222222', '--field': '#141414', '--border': '#737373', '--border-soft': '#444444',
    '--text': '#eeeeee', '--muted': '#b3b3b3', '--hover': '#383838', '--select': '#4a4a4a', '--accent': '#d8d8d8',
  }),
  palette('solarized-dark', 'Solarized Dark', 'Ethan Schoonover’s balanced palette with a deep teal background.', 'dark', {
    background: '#002b36', foreground: '#839496', cursor: '#839496', cursorAccent: '#002b36',
    selectionBackground: '#073642', selectionForeground: '#93a1a1',
  }, solarizedAnsi, {
    '--chrome': '#073642', '--panel': '#002b36', '--field': '#002b36', '--border': '#586e75', '--border-soft': '#073642',
    '--text': '#93a1a1', '--muted': '#839496', '--hover': '#073642', '--select': '#073642', '--accent': '#2aa198',
  }),
  palette('solarized-light', 'Solarized Light', 'The Solarized palette on a warm paper background.', 'light', {
    background: '#fdf6e3', foreground: '#657b83', cursor: '#657b83', cursorAccent: '#fdf6e3',
    selectionBackground: '#eee8d5', selectionForeground: '#586e75',
  }, solarizedAnsi, {
    '--chrome': '#eee8d5', '--panel': '#fdf6e3', '--field': '#fdf6e3', '--border': '#839496', '--border-soft': '#eee8d5',
    '--text': '#586e75', '--muted': '#657b83', '--hover': '#eee8d5', '--select': '#eee8d5', '--accent': '#006783',
  }),
  palette('forge-dark', 'Forge Dark', 'A cool charcoal background with warm copper and clear colored text.', 'dark', {
    background: '#111923', foreground: '#dbe4ee', cursor: '#f0b35b', cursorAccent: '#111923',
    selectionBackground: '#354a63', selectionForeground: '#ffffff',
  }, [
    '#111923', '#f17f8c', '#9dcc85', '#e6c277', '#82b3e9', '#c997df', '#7dc5c4', '#ccd6e1',
    '#758394', '#ffacb6', '#bee5a9', '#f4db9b', '#afd2fa', '#e2b9f1', '#a5e2df', '#f6f8fb',
  ], {
    '--chrome': '#1d2a39', '--panel': '#16212d', '--field': '#111923', '--border': '#5c7189', '--border-soft': '#35465a',
    '--text': '#dbe4ee', '--muted': '#a0afbf', '--hover': '#293c50', '--select': '#354a63', '--accent': '#f0b35b',
  }),
  palette('forge-light', 'Forge Light', 'A cool paper background with deep ink and muted colored text.', 'light', {
    background: '#f4f6f8', foreground: '#26384a', cursor: '#26384a', cursorAccent: '#f4f6f8',
    selectionBackground: '#c6d9ed', selectionForeground: '#182a3b',
  }, [
    '#1c2936', '#aa263c', '#326a29', '#805c12', '#215fa4', '#854092', '#1b6c71', '#a5afba',
    '#5c6e80', '#be354a', '#3c7a31', '#936b19', '#276db8', '#9b4caa', '#207c81', '#ffffff',
  ], {
    '--chrome': '#e4ebf1', '--panel': '#f4f6f8', '--field': '#ffffff', '--border': '#8294a5', '--border-soft': '#c6d1db',
    '--text': '#26384a', '--muted': '#52677b', '--hover': '#dce7f1', '--select': '#c6d9ed', '--accent': '#8a4a08',
  }),
  palette('high-contrast', 'High Contrast', 'Bright text and bold ANSI accents on a pure black background.', 'dark', {
    background: '#000000', foreground: '#ffffff', cursor: '#ffff00', cursorAccent: '#000000',
    selectionBackground: '#ffffff', selectionForeground: '#000000',
  }, [
    '#767676', '#ff8b8b', '#6bea83', '#ffdb66', '#84b7ff', '#ec9fff', '#60dfdf', '#eaeaea',
    '#a0a0a0', '#ffb6b6', '#afffbf', '#ffefad', '#b7d6ff', '#f4c7ff', '#afffff', '#ffffff',
  ], {
    '--chrome': '#000000', '--panel': '#000000', '--field': '#000000', '--border': '#b8b8b8', '--border-soft': '#767676',
    '--text': '#ffffff', '--muted': '#d5d5d5', '--hover': '#303030', '--select': '#3a3a3a', '--accent': '#ffff00',
  }),
]);

const COLOR_SCHEME_IDS = Object.freeze(COLOR_SCHEMES.map(scheme => scheme.id));
const schemesById = new Map(COLOR_SCHEMES.map(scheme => [scheme.id, scheme]));

// Empty per-session IDs inherit the global selection. Unknown IDs are handled
// the same way for preview resilience; persisted configuration remains strict.
function resolveColorScheme(sessionId, globalId = DEFAULT_COLOR_SCHEME) {
  return schemesById.get(sessionId) || schemesById.get(globalId) || schemesById.get(DEFAULT_COLOR_SCHEME);
}

module.exports = { COLOR_SCHEMES, COLOR_SCHEME_IDS, DEFAULT_COLOR_SCHEME, ANSI_COLOR_KEYS, resolveColorScheme };
