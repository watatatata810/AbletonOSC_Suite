// packages/shared-utils/testConfigLoader.js
const { getPackageConfig } = require('./configLoader');
const assert = require('assert');

const mockConfig = {
  packages: [
    { name: 'testApp', httpPort: 5000, oscPort: 6000 }
  ],
  testApp: {
    legacyParam: 'yes',
    httpPort: 4000 // 旧設定の値
  }
};

// テスト1: 新しいインライン設定が正しく取得できること、旧設定とマージされて新設定（packages内）が優先されること
try {
  const result = getPackageConfig(mockConfig, 'testApp');
  assert.strictEqual(result.httpPort, 5000, 'packages内の設定が優先されるべきです');
  assert.strictEqual(result.oscPort, 6000, 'packages内の設定が取得できるべきです');
  assert.strictEqual(result.legacyParam, 'yes', '個別オブジェクトの設定もマージされるべきです');
  console.log('✓ Task 1 Tests Passed!');
} catch (err) {
  console.error('✗ Task 1 Tests Failed:', err.message);
  process.exit(1);
}
