// Original, local vector artwork. All interface symbols share a 24px grid.
const paths = {
  ai: 'M12 3l2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3 M20 3v4 M18 5h4',
  connect: 'M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-2 2 M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l2-2',
  disconnect: 'M8 3v4 M16 3v4 M6 7h12v3a6 6 0 0 1-12 0V7 M12 16v5 M3 3l18 18',
  reconnect: 'M20 10a8 8 0 1 0-2 8 M20 4v6h-6',
  new: 'M12 5v14 M5 12h14',
  terminal: 'M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z M7 9l3 3-3 3 M13 15h4',
  sessions: 'M5 3h14a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z M5 13h14a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2Z M7 7h.01 M7 17h.01 M11 7h6 M11 17h6',
  commands: 'M5 6l6 6-6 6 M13 18h6',
  active: 'M3 12h4l3-8 4 16 3-8h4',
  folder: 'M3 7V5a2 2 0 0 1 2-2h5l3 4h6a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z',
  options: 'M4 6h16 M4 12h16 M4 18h16 M8 3v6 M16 9v6 M10 15v6',
  copy: 'M9 8h10a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2Z M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h2',
  paste: 'M8 5H5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-3 M9 2h6a1 1 0 0 1 1 1v4H8V3a1 1 0 0 1 1-1Z M7 12h10 M7 16h7',
  find: 'M18 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0 M15 15l6 6',
  transfer: 'M7 3v18 M3 7l4-4 4 4 M17 21V3 M13 17l4 4 4-4',
  log: 'M6 3h9l4 4v14H6V3Z M14 3v5h5 M9 12h7 M9 16h5',
  tile: 'M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z M12 3v18 M12 12h9',
  palette: 'M12 3a9 9 0 1 0 0 18h1a2 2 0 0 0 1-3.7 1.5 1.5 0 0 1 1-2.8h2a4 4 0 0 0 4-4c0-4.1-4-7.5-9-7.5 M7 10h.01 M10 6.5h.01 M15 7h.01 M18 10.5h.01',
  settings: 'M4 6h16 M4 12h16 M4 18h16 M8 3v6 M16 9v6 M10 15v6',
  help: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0 M9 9a3 3 0 0 1 6 0c0 2-3 2-3 4 M12 17h.01',
  import: 'M12 3v12 M7 10l5 5 5-5 M4 15v5a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-5',
};

export function createIcon(name, className = '') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', `tool-icon icon-${name}${className ? ` ${className}` : ''}`);
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', paths[name] || paths.options);
  svg.append(path);
  return svg;
}
