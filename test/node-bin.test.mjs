// 常驻进程稳定 node 路径解析测试：防止 Homebrew 升级 node 后子进程被旧 Cellar 路径钉死。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { stableNodeExecPath } from '../src/ops/node-bin.mjs';

const has = (...paths) => {
  const set = new Set(paths);
  return (p) => set.has(p);
};

describe('stableNodeExecPath', () => {
  test('launchd 用 /opt/homebrew/bin/node 启动时，保留稳定软链而不是 Cellar 真实路径', () => {
    const got = stableNodeExecPath({
      argv0: '/opt/homebrew/bin/node',
      execPath: '/opt/homebrew/Cellar/node/26.13.0_2/bin/node',
      existsSync: has('/opt/homebrew/bin/node', '/opt/homebrew/opt/node/bin/node'),
    });
    assert.equal(got, '/opt/homebrew/bin/node');
  });

  test('终端用相对命令 node 启动且 execPath 在 Cellar 时，规整为 /opt/homebrew/opt/node/bin/node', () => {
    const got = stableNodeExecPath({
      argv0: 'node',
      execPath: '/opt/homebrew/Cellar/node/26.13.0_2/bin/node',
      existsSync: has('/opt/homebrew/opt/node/bin/node', '/opt/homebrew/bin/node'),
    });
    assert.equal(got, '/opt/homebrew/opt/node/bin/node');
  });

  test('opt 软链不存在但 /opt/homebrew/bin/node 存在时，退回 bin 软链', () => {
    const got = stableNodeExecPath({
      argv0: 'node',
      execPath: '/opt/homebrew/Cellar/node/26.13.0_2/bin/node',
      existsSync: has('/opt/homebrew/bin/node'),
    });
    assert.equal(got, '/opt/homebrew/bin/node');
  });

  test('即使 argv0 本身指向 Cellar 版本路径，也规整为稳定软链', () => {
    const got = stableNodeExecPath({
      argv0: '/opt/homebrew/Cellar/node/26.13.0_2/bin/node',
      execPath: '/opt/homebrew/Cellar/node/26.13.0_2/bin/node',
      existsSync: has('/opt/homebrew/opt/node/bin/node'),
    });
    assert.equal(got, '/opt/homebrew/opt/node/bin/node');
  });

  test('版本化 formula（如 node@22）规整到对应的 opt 路径，不误切到无版本 bin/node', () => {
    const got = stableNodeExecPath({
      argv0: 'node',
      execPath: '/opt/homebrew/Cellar/node@22/22.14.0/bin/node',
      existsSync: has('/opt/homebrew/opt/node@22/bin/node', '/opt/homebrew/bin/node'),
    });
    assert.equal(got, '/opt/homebrew/opt/node@22/bin/node');

    const fallback = stableNodeExecPath({
      argv0: 'node',
      execPath: '/opt/homebrew/Cellar/node@22/22.14.0/bin/node',
      existsSync: has('/opt/homebrew/bin/node'),
    });
    assert.equal(fallback, '/opt/homebrew/Cellar/node@22/22.14.0/bin/node');
  });

  test('非 Homebrew 路径或不存在的 argv0 回退 execPath', () => {
    assert.equal(stableNodeExecPath({
      argv0: 'node',
      execPath: '/Users/demo/.nvm/versions/node/v22.12.0/bin/node',
      existsSync: has('/Users/demo/.nvm/versions/node/v22.12.0/bin/node'),
    }), '/Users/demo/.nvm/versions/node/v22.12.0/bin/node');

    assert.equal(stableNodeExecPath({
      argv0: '/nonexistent/node',
      execPath: '/usr/bin/node',
      existsSync: has('/usr/bin/node'),
    }), '/usr/bin/node');
  });
});
