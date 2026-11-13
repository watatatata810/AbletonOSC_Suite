const { exec } = require('child_process');
const path = require('path');
const { neutralinoBinaryName } = require('../shared-utils/neutralinoBinary');

const binaryPath = path.join(__dirname, 'bin', neutralinoBinaryName());
const cmd = `"${binaryPath}" --load-dir-res --path=.`;

console.log(`[Launcher] Starting Neutralinojs binary: ${binaryPath}`);
exec(cmd, (err) => {
  if (err) {
    console.error('Failed to start Neutralinojs:', err);
    process.exit(1);
  }
});
