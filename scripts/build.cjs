'use strict';
const esbuild = require('esbuild');
const path = require('node:path');
esbuild.build({
  entryPoints: [path.join(__dirname, '../renderer/src.js')],
  bundle: true,
  outfile: path.join(__dirname, '../renderer/dist/app.js'),
  platform: 'browser',
  target: 'chrome140',
  minify: true,
  sourcemap: false,
  legalComments: 'eof',
  loader: { '.woff2': 'file', '.woff': 'file', '.ttf': 'file' }
}).catch(() => process.exit(1));
