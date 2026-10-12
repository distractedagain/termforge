'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
module.exports = async ({ window }) => {
  const result = await window.webContents.executeJavaScript(`(async () => {
    if (typeof window.require !== 'undefined') throw new Error('Renderer Node isolation failed');
    const state = await window.harbor.getState();
    let output = '';
    let id;
    const unsubscribe = window.harbor.onTerminalData(event => { if (event.id === id) output += event.data; });
    const terminal = await window.harbor.terminalOpen({profile:{name:'Packaged terminal test',protocol:'local'}});
    id = terminal.id;
    await window.harbor.terminalWrite({id,data:${JSON.stringify(process.platform === 'win32' ? "echo HARBOR_PACKAGE_^OK\r" : "printf 'HARBOR_PACKAGE_%s\\n' 'OK'\r")}});
    const deadline = Date.now() + 12000;
    while (!output.includes('HARBOR_PACKAGE_OK') && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
    await window.harbor.terminalClose(id);
    unsubscribe();
    if (!output.includes('HARBOR_PACKAGE_OK')) throw new Error('Packaged PTY did not return real shell output');
    return {packagedApp:true,realPTY:true,nodeIsolated:true,version:state.version,platform:state.platform};
  })()`);
  if (process.env.HARBOR_SMOKE_DIR) await fs.writeFile(path.join(process.env.HARBOR_SMOKE_DIR, 'packaged-result.json'), JSON.stringify(result, null, 2));
  console.log('Packaged app smoke test passed: ' + JSON.stringify(result));
};
