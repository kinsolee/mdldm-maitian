// 把一批事件交给 OpenBot：本机 openbot-cli run <bot> - --id maitian-<批次键>。
// 任务文字里只有事件 id，不带评论私信正文：正文由 agent 用麦田 MCP 自己读，内容不进命令行，也不进日志。
import { spawn } from 'node:child_process';

export const FORWARD_TIMEOUT_MS = 60_000;

export function taskText(ids) {
  return [
    `麦田事件 ${ids.length} 条。按 persona「麦田事件处理」一节处理下面这些事件 id，每条处理完都要 ack_event。`,
    '先调一次 list_events({ unhandled: true }) 补漏，一并处理。',
    ...ids.map((id) => `- ${id}`),
  ].join('\n');
}

/** OpenBot 的重试键：同一批事件永远是同一个键，重投会被 OpenBot 认成同一条消息。 */
export const clientMessageId = (key) => `maitian-${key}`;

/**
 * 返回 forward(ids, key) => Promise<{ deliveryId, status }>。CLI 非零退出或超时时抛错，错误文字不含任务正文。
 * 退出码见 openbot-cli：1 失败或被拒，2 命令行错，3 等人，4 超时，5 连不上 OpenBot 或找不到 bot。
 */
export function cliForwarder({ cli, agent, timeoutMs = FORWARD_TIMEOUT_MS, node = process.execPath }) {
  return (ids, key) => new Promise((resolve, reject) => {
    const child = spawn(node, [cli, 'run', agent, '-', '--id', clientMessageId(key), '--json'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`openbot-cli 超时（${Math.round(timeoutMs / 1000)} 秒）`)); }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); reject(new Error(`openbot-cli 起不来：${e.code ?? e.message}`)); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) { reject(new Error(`openbot-cli 退出码 ${code}：${err.trim().slice(0, 200) || '（无输出）'}`)); return; }
      try {
        const r = JSON.parse(out);
        const v = r.result ?? r;
        resolve({ deliveryId: v.deliveryId ?? null, status: v.status ?? null });
      } catch {
        resolve({ deliveryId: null, status: null });
      }
    });
    child.stdin.end(taskText(ids));
  });
}
