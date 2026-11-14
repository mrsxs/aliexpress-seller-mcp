import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLsof, parseNetstat, parseTasklist } from '../lib/ports.mjs';

test('端口解析：lsof / netstat / tasklist', () => {
  assert.deepEqual(parseLsof('superbrow 123 apple 40u IPv4 0x1 0t0 TCP 127.0.0.1:18204 (LISTEN)\nnode 9 a 1u IPv4 0x2 0t0 TCP *:80 (LISTEN)'), [{ name: 'superbrow', port: 18204 }]);
  assert.deepEqual(parseNetstat('  TCP    127.0.0.1:9222    0.0.0.0:0    LISTENING    4321\n  TCP    127.0.0.1:5000    127.0.0.1:6000    ESTABLISHED  1'), [{ port: 9222, pid: 4321 }]);
  assert.equal(parseTasklist('"SuperBrowser.exe","4321","Console","1","10,000 K"').get(4321), 'SuperBrowser.exe');
});
