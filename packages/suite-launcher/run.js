const { exec } = require('child_process');
const path = require('path');

let binary = '';
if (process.platform === 'win32') {
  binary = 'neutralino-win_x64.exe';
} else if (process.platform === 'darwin') {
  binary = 'neutralino-mac_x64';
} else {
  binary = 'neutralino-linux_x64';
}

const binaryPath = path.join(__dirname, 'bin', binary);
const cmd = `"${binaryPath}" --load-dir-res --path=.`;

console.log(`[Launcher] Starting Neutralinojs binary: ${binaryPath}`);
exec(cmd, (err) => {
  if (err) {
    console.error('Failed to start Neutralinojs:', err);
    process.exit(1);
  }
});
