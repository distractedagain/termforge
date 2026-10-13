'use strict';
const esbuild = require('esbuild');
const path = require('node:path');
const common = {
  bundle: true,
  platform: 'browser',
  target: 'chrome140',
  minify: true,
  sourcemap: false,
  legalComments: 'eof'
};
Promise.all([esbuild.build({
  ...common,
  entryPoints: [path.join(__dirname, '../renderer/src.js')],
  outfile: path.join(__dirname, '../renderer/dist/app.js'),
  loader: { '.woff2': 'file', '.woff': 'file', '.ttf': 'file' }
}), esbuild.build({
  ...common,
  entryPoints: {
    'editor.worker': require.resolve('monaco-editor/editor/editor.worker.js'),
    'json.worker': require.resolve('monaco-editor/language/json/json.worker.js')
  },
  outdir: path.join(__dirname, '../renderer/dist'),
  format: 'esm'
})]).catch(() => process.exit(1));
