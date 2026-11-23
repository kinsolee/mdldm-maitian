// 常驻进程起 node 子进程时的稳定路径解析：避免 macOS Homebrew 升级 node 后，
// process.execPath 仍钉死在旧 Cellar 版本目录（动态库已更新导致子进程 dyld 崩溃）。
import fs from 'node:fs';
import path from 'node:path';

const CELLAR_NODE_RE = /^(.+?)\/Cellar\/(node(?:@[^/]+)?)\/[^/]+\/bin\/node$/;

/**
 * 返回不带 Homebrew Cellar 版本号的稳定 node 路径：
 * 1. 若 argv0 是绝对路径、不在 Cellar 版本目录里且文件存在（如 launchd 传入的 /opt/homebrew/bin/node），直接用它；
 * 2. 若 execPath 落在 Homebrew Cellar（.../Cellar/node[@ver]/<ver>/bin/node），规整为无版本号软链
 *    （优先 .../opt/<formula>/bin/node，否则 formula 为 node 时退回 .../bin/node）；
 * 3. 其他环境回退 execPath。
 */
export function stableNodeExecPath({ argv0 = process.argv0, execPath = process.execPath, existsSync = fs.existsSync } = {}) {
  if (typeof argv0 === 'string' && path.isAbsolute(argv0) && !CELLAR_NODE_RE.test(argv0) && existsSync(argv0)) {
    return argv0;
  }
  const m = typeof execPath === 'string' ? CELLAR_NODE_RE.exec(execPath) : null;
  if (m) {
    const [, prefix, formula] = m;
    const optBin = path.join(prefix, 'opt', formula, 'bin', 'node');
    if (existsSync(optBin)) return optBin;
    if (formula === 'node') {
      const brewBin = path.join(prefix, 'bin', 'node');
      if (existsSync(brewBin)) return brewBin;
    }
  }
  return execPath;
}
