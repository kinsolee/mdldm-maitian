#!/usr/bin/env node
// 假 colab CLI：FAKE_COLAB_MODE=auth（没授权）| ok（空闲）| active（有一个会话）| fail；stop 调用记到 FAKE_COLAB_LOG
import fs from 'node:fs';
const mode = process.env.FAKE_COLAB_MODE || 'ok', [cmd, , id] = process.argv.slice(2);
if (process.env.FAKE_COLAB_LOG) fs.appendFileSync(process.env.FAKE_COLAB_LOG, process.argv.slice(2).join(' ') + '\n');
if (mode === 'auth') {
  process.stderr.write('\nTo authorize colab-cli, visit this URL in any browser:\n\n  https://accounts.example/o?x=1\n\nAfter approving, Google will display an authorization code.\n');
  process.stdout.write('Enter the authorization code: ');
  process.stderr.write('[colab] Warning: failed to fetch compute-unit info: EOF when reading a line\n');
  process.exit(1);
}
if (mode === 'fail') { process.stderr.write('boom secret-ish detail\n'); process.exit(2); }
if (cmd === 'usage') console.log(`Current balance: 2497.39 compute units\nUsage rate: ${mode === 'active' ? '1.76' : '0.00'}/hr\nActive assignments: ${mode === 'active' ? 1 : 0}`);
else if (cmd === 'sessions') console.log(mode === 'active' ? '[gpu-1] m-s-abc123 | Hardware: T4 | Shape: Standard | Variant: GPU\n[?] m-s-orphan | Hardware: CPU | Shape: Standard | Variant: DEFAULT' : '[colab] No active sessions found on server.');
else if (cmd === 'stop') console.log(`[colab] Stopping session '${id}'...\n[colab] Session terminated.`);
