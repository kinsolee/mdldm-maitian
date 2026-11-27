// 小V猫上游只读 MCP 客户端：
// 1. 仅允许 initialize、tools/list 以及固定白名单内的只读工具；
// 2. 写工具（包括 vcat_draft_reply）在客户端层即硬拦截，绝不发出请求；
// 3. 任何调用参数里的 refresh（含嵌套对象）强制锁定为 false，绝不触发平台实时刷新。
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export const VCAT_READ_WHITELIST = Object.freeze([
  'vcat_list_accounts',
  'vcat_list_comments',
  'vcat_get_comment_summary',
  'vcat_get_unread_messages',
  'vcat_list_message_sessions',
  'vcat_get_session_messages',
]);

const WHITELIST_SET = new Set(VCAT_READ_WHITELIST);
const REFRESH_KEY_PATTERN = /^(refresh|force_?refresh|live_?refresh)$/i;

export function isAllowedUpstreamTool(name) {
  return typeof name === 'string' && WHITELIST_SET.has(name);
}

function deepForceRefreshFalse(value) {
  if (Array.isArray(value)) return value.map((item) => deepForceRefreshFalse(item));
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, val] of Object.entries(value)) {
    if (REFRESH_KEY_PATTERN.test(key)) out[key] = false;
    else out[key] = deepForceRefreshFalse(val);
  }
  return out;
}

/** 净化发往上游的工具参数：无论是否传参，所有白名单工具顶层与任意嵌套层级的 refresh 一律强制为 false。 */
export function sanitizeUpstreamArgs(toolName, rawArgs) {
  const base = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)
    ? deepForceRefreshFalse(rawArgs)
    : {};
  base.refresh = false;
  return base;
}

/** 过滤上游 tools/list 结果，只保留白名单工具，并在 schema 上把 refresh 锁死为 false。 */
export function filterUpstreamTools(tools = []) {
  const exposed = [];
  let droppedCount = 0;
  for (const tool of tools) {
    if (!tool || !isAllowedUpstreamTool(tool.name)) {
      droppedCount += 1;
      continue;
    }
    const schema = tool.inputSchema && typeof tool.inputSchema === 'object'
      ? structuredClone(tool.inputSchema)
      : { type: 'object', properties: {} };
    if (schema.properties && typeof schema.properties === 'object') {
      for (const key of Object.keys(schema.properties)) {
        if (REFRESH_KEY_PATTERN.test(key)) {
          schema.properties[key] = {
            type: 'boolean',
            enum: [false],
            default: false,
            description: '只读代理强制锁定为 false（禁止实时刷新平台）',
          };
        }
      }
      if (!Object.prototype.hasOwnProperty.call(schema.properties, 'refresh')) {
        schema.properties.refresh = {
          type: 'boolean',
          enum: [false],
          default: false,
          description: '只读代理强制锁定为 false（禁止实时刷新平台）',
        };
      }
    }
    exposed.push({
      name: tool.name,
      description: `${tool.description || tool.name}（只读影子代理：refresh 已锁定 false）`,
      inputSchema: schema,
    });
  }
  return { exposedTools: exposed, upstreamTotal: tools.length, droppedCount };
}

/** 严格解析 MCP 工具返回的 JSON 内容：上游报错、空响应或非 JSON 一律抛脱敏错误，绝不静默返回空值或回显正文。 */
export function parseToolResultJson(result) {
  if (!result || result.isError) {
    throw new Error('上游只读工具返回错误（正文已脱敏）');
  }
  if (result.structuredContent !== undefined) return result.structuredContent;
  const text = (result.content || [])
    .filter((item) => item?.type === 'text' && typeof item.text === 'string')
    .map((item) => item.text)
    .join('\n')
    .trim();
  if (!text) {
    throw new Error('上游只读工具返回空响应');
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('上游只读工具返回非 JSON 响应');
  }
}

/** 脱敏上游传输错误：绝不把 SDK 拼入的 HTTP 响应体、参数或令牌泄漏到异常消息与日志。 */
export function redactUpstreamError(err, action = '上游调用') {
  if (!err) return new Error(`${action}失败`);
  if (err.name === 'AbortError' || err.name === 'TimeoutError') {
    return new Error(`${action}超时`);
  }
  const statusCode = Number(err.code || err.status || err.statusCode);
  if (Number.isInteger(statusCode) && statusCode >= 400 && statusCode <= 599) {
    return new Error(`${action}失败（HTTP ${statusCode}）`);
  }
  const httpMatch = /\bHTTP\s+(\d{3})\b/i.exec(String(err.message || ''));
  if (httpMatch) {
    return new Error(`${action}失败（HTTP ${httpMatch[1]}）`);
  }
  const netCode = err.cause?.code || (typeof err.code === 'string' ? err.code : '');
  if (netCode && /^[A-Z0-9_]+$/.test(netCode)) {
    return new Error(`${action}网络错误（${netCode}）`);
  }
  return new Error(`${action}失败（原因已脱敏）`);
}

export function createUpstreamClient({ url, token, timeoutMs = 20_000 }) {
  if (!url) throw new Error('缺少上游小V猫 MCP 地址');
  if (!token) throw new Error('缺少上游小V猫 MCP Bearer 令牌');

  async function withClient(fn) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const transport = new StreamableHTTPClientTransport(new URL(url), {
      requestInit: {
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      },
    });
    const client = new Client({ name: 'maitian-vcat-readonly-proxy', version: '0.1.0' });
    try {
      await client.connect(transport);
      return await fn(client);
    } catch (err) {
      throw redactUpstreamError(err, '上游小V猫 MCP');
    } finally {
      clearTimeout(timer);
      await client.close().catch(() => {});
    }
  }

  return {
    url,
    async syncTools() {
      const allTools = await withClient(async (client) => {
        const collected = [];
        const seenCursors = new Set();
        let cursor;
        for (let page = 0; page < 20; page += 1) {
          const res = await client.listTools(cursor ? { cursor } : undefined);
          if (Array.isArray(res?.tools)) collected.push(...res.tools);
          if (!res?.nextCursor || seenCursors.has(res.nextCursor)) break;
          seenCursors.add(res.nextCursor);
          cursor = res.nextCursor;
        }
        return collected;
      });
      return filterUpstreamTools(allTools);
    },
    async callReadTool(name, rawArgs = {}) {
      if (!isAllowedUpstreamTool(name)) {
        throw new Error(`工具 ${name} 不在只读白名单中，已拒绝调用`);
      }
      const safeArgs = sanitizeUpstreamArgs(name, rawArgs);
      return withClient((client) => client.callTool({ name, arguments: safeArgs }));
    },
  };
}
