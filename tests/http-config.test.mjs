import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readHttpConfig } from '../dist/http-config.js';

test('defaults preserve loopback-only local binding', () => {
  const value = readHttpConfig({});
  assert.equal(value.host, '127.0.0.1');
  assert.equal(value.apiOrigin, 'http://localhost:4000');
  assert.ok(!value.chatHostnames.includes('unconfigured.example'));
});
test('deployment URLs normalize trailing slash and allow only the configured API hostname', () => {
  const value = readHttpConfig({
    HOST: '0.0.0.0',
    PORT: '8080',
    API_ORIGIN: 'https://api.example.com/',
    WEB_ORIGIN: 'https://chat.example.com/',
  });
  assert.equal(value.host, '0.0.0.0');
  assert.equal(value.port, 8080);
  assert.equal(value.apiOrigin, 'https://api.example.com');
  assert.equal(value.webOrigin, 'https://chat.example.com');
  assert.ok(value.chatHostnames.includes('api.example.com'));
  assert.ok(!value.chatHostnames.includes('other.example.com'));
});
test('rejects malformed deployment configuration', () => {
  for (const port of ['0', 'NaN', '65536'])
    assert.throws(() => readHttpConfig({ PORT: port }));
  for (const value of [
    'ftp://example.com',
    'https://example.com/api',
    'https://user:pass@example.com',
    'https://example.com?query=1',
  ]) {
    assert.throws(() => readHttpConfig({ API_ORIGIN: value }));
  }
});
