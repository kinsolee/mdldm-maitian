// 共用脱敏函数（日志、库、飞书、适配器错误都用它）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redact } from '../src/ops/engage/redact.mjs';

const leaks = (s, bad) => bad.filter((b) => s.includes(b));

test('G-B9：msToken、SESSDATA、a_bogus、bili_jct、web_session、csrf、sign、ticket、a1 都打码（大小写不敏感、不要求词边界）', () => {
  const s = redact('失败 msToken=MT111; SESSDATA=SD222 a_bogus=AB333 bili_jct:BJ444 web_session=WS555 X-CSRF-Token: CS666 sign=SG777 ticket=TK888 a1=A1999 xsec_token=XS000');
  assert.deepEqual(leaks(s, ['MT111', 'SD222', 'AB333', 'BJ444', 'WS555', 'CS666', 'SG777', 'TK888', 'A1999', 'XS000']), [], s);
  assert.match(s, /msToken=\*\*\*/);
});

test('G-B9：带 query 的 URL 只留 origin + path', () => {
  const s = redact('打开 https://www.douyin.com/aweme/v1/web/comment/list/?aweme_id=1&msToken=abc&a_bogus=def#frag 超时');
  assert.ok(s.includes('https://www.douyin.com/aweme/v1/web/comment/list/'), s);
  assert.deepEqual(leaks(s, ['aweme_id', 'abc', 'def', 'frag']), [], s);
});

test('G-B9：Authorization / Bearer、cookie 串整段去掉；普通文字不动；截到 300 字', () => {
  const s = redact('Authorization: Bearer eyJhbGci.payload.sig\ncookie: SESSDATA=1; bili_jct=2; buvid3=3\n页面落到了登录页');
  assert.deepEqual(leaks(s, ['eyJhbGci', 'buvid3', '=1', '=2']), [], s);
  assert.ok(s.includes('页面落到了登录页'));
  assert.equal(redact('timeout：等了 30 秒'), 'timeout：等了 30 秒');
  assert.equal(redact('x'.repeat(500)).length, 300);
  assert.equal(redact(null), '');
});
