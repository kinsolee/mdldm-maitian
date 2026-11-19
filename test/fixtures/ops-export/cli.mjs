// 测试用：在子进程里跑 hub ops 的 main，注入假 runner、假平台模块（ego-browser 不会被调用）。
// 用法：node cli.mjs <hub ops 参数...>；FAKE_NOW 指定当前时间（毫秒），FAKE_MAPPED 可覆盖某平台的 map 结果（JSON）。
import { main } from '../../../src/ops/cli.mjs';
import { fakes } from './fake.mjs';

const now = process.env.FAKE_NOW ? () => Number(process.env.FAKE_NOW) : Date.now;
const { runTask, loadPlatform, moduleUrlOf } = fakes(JSON.parse(process.env.FAKE_MAPPED || '{}'));
main(process.argv.slice(2), { runTask, loadPlatform, moduleUrlOf, now }).then((code) => process.exit(code), (e) => { console.error(`出错：${e.message}`); process.exit(1); });
