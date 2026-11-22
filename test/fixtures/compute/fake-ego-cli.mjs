#!/usr/bin/env node
// 假 ego-runner cli：FAKE_EGO_MODE=ok | busy | user-controlled | timeout | partial；FAKE_EGO_DELAY 毫秒；每次启动记到 FAKE_EGO_LOG
import fs from 'node:fs';
const mode = process.env.FAKE_EGO_MODE || 'ok';
if (process.env.FAKE_EGO_LOG) fs.appendFileSync(process.env.FAKE_EGO_LOG, process.argv.slice(2).join(' ') + '\n');
await new Promise((r) => setTimeout(r, Number(process.env.FAKE_EGO_DELAY || 0)));
const ok = { flow: { status: 'ok', metrics: { credits: 25031, resetText: '12月9日 15:22', reset: { month: 12, day: 9, hour: 15, minute: 22 } } },
  flowmusic: { status: 'ok', metrics: { credits: 30560 } },
  kaggle: { status: 'ok', metrics: { gpu: { leftHours: 60, totalHours: 60 }, tpu: { leftHours: 20, totalHours: 20 }, sessionsKnown: true }, sessions: mode === 'kaggle-active' ? [{ id: '1', title: 'nb' }] : [] },
  pics: { status: 'ok', metrics: { signedIn: true } }, vids: { status: 'ok', metrics: { signedIn: true } } };
if (mode === 'ok' || mode === 'kaggle-active') { console.log(JSON.stringify({ ok: true, result: ok })); process.exit(0); }
if (mode === 'partial') { console.log(JSON.stringify({ ok: true, result: { ...ok, flow: { status: 'logged_out', error: 'Flow 登录失效' }, vids: undefined } })); process.exit(0); }
console.log(JSON.stringify({ ok: false, reason: mode, output: 'x' }));
process.exit(mode === 'busy' ? 5 : mode === 'user-controlled' ? 4 : 1);
