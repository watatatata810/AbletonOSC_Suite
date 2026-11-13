// packages/shared-utils/testNeutralinoBinary.js  (node packages/shared-utils/testNeutralinoBinary.js)
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { neutralinoBinaryName } = require('./neutralinoBinary');

const cases = [
  ['win32', 'x64', 'neutralino-win_x64.exe'],
  ['darwin', 'arm64', 'neutralino-mac_arm64'],
  ['darwin', 'x64', 'neutralino-mac_x64'],
  ['linux', 'x64', 'neutralino-linux_x64'],
  ['linux', 'arm64', 'neutralino-linux_arm64'],
  ['linux', 'arm', 'neutralino-linux_armhf'],
];
for (const [platform, arch, expected] of cases) {
  const name = neutralinoBinaryName(platform, arch);
  assert.strictEqual(name, expected, `${platform}/${arch}`);
  // 選んだファイルが Neutralino を使う両パッケージの bin/ に実在すること
  for (const pkg of ['suite-launcher', 'viewWaves']) {
    assert.ok(fs.existsSync(path.join(__dirname, '..', pkg, 'bin', name)), `${pkg}/bin/${name} がありません`);
  }
}
console.log('✅ neutralinoBinaryName: all cases passed');
