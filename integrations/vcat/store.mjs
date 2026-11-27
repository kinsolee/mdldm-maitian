// 小V猫影子版独立存储（integrations/vcat/data/shadow.db）。
// 包含：inbox（去重新评论/私信）、kb_entries（问答库，影子期 auto_reply 永远为 0）、
// cards + card_items（评论卡/私信卡/聚合卡）、shadow_log（影子判定）、meta（水位）。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { assertSafeKbExportPath } from './config.mjs';

export const BUSY_TIMEOUT_MS = 5000;
export const PENDING_LIMIT = 20;
export const CARD_TYPES = Object.freeze(['comment', 'dm', 'aggregate']);
export const CARD_STATUSES = Object.freeze(['pending', 'answered', 'skipped', 'expired']);
export const SHADOW_DECISIONS = Object.freeze(['hit', 'new_question', 'ad', 'skip']);

const iso = (now) => new Date(typeof now === 'function' ? now() : now).toISOString();
const nonEmpty = (value) => typeof value === 'string' && value.trim().length > 0;
const normalizeText = (value) => String(value || '')
  .toLowerCase()
  .replace(/[\s\p{P}\p{S}]+/gu, ' ')
  .trim();

/** 提取中英文词元与中文 2-gram，用于本地问答库召回候选。 */
export function extractTerms(text) {
  const normalized = normalizeText(text);
  if (!normalized) return new Set();
  const terms = new Set();
  for (const part of normalized.split(/\s+/)) {
    if (!part) continue;
    if (part.length >= 2) terms.add(part);
    const cjkRuns = part.match(/[\u4e00-\u9fff]+/g) || [];
    for (const run of cjkRuns) {
      if (run.length === 1) terms.add(run);
      for (let idx = 0; idx < run.length - 1; idx += 1) {
        terms.add(run.slice(idx, idx + 2));
      }
    }
    const latinRuns = part.match(/[a-z0-9]+/g) || [];
    for (const run of latinRuns) {
      if (run.length >= 2) terms.add(run);
    }
  }
  return terms;
}

function scoreKbMatch(query, queryTerms, entry, targetPlatform) {
  const normQuery = normalizeText(query);
  const normQuestion = normalizeText(entry.question);
  const questionTerms = extractTerms(entry.question);
  const keywordList = String(entry.keywords || '')
    .split(/[\s,，;；/]+/)
    .map((kw) => normalizeText(kw))
    .filter(Boolean);
  if (!normQuery || (questionTerms.size === 0 && keywordList.length === 0)) return 0;

  let overlap = 0;
  for (const term of queryTerms) {
    if (questionTerms.has(term)) overlap += 1;
  }
  const union = new Set([...queryTerms, ...questionTerms]).size || 1;
  const jaccard = overlap / union;
  const recall = queryTerms.size > 0 ? overlap / queryTerms.size : 0;
  let score = questionTerms.size > 0 ? (0.6 * recall + 0.4 * jaccard) : 0;

  if (keywordList.length > 0) {
    const kwHits = keywordList.filter((kw) => normQuery.includes(kw)).length;
    if (kwHits > 0) score = Math.min(1, score + Math.min(0.35, kwHits * 0.15));
  }

  if (normQuestion && (normQuestion.includes(normQuery) || normQuery.includes(normQuestion))) {
    score = Math.max(score, 0.85);
  }
  if (score <= 0) return 0;

  const entryPlatform = String(entry.platform || 'all').toLowerCase();
  const wantedPlatform = targetPlatform ? String(targetPlatform).toLowerCase() : '';
  if (wantedPlatform && wantedPlatform !== 'all') {
    if (entryPlatform === wantedPlatform) score = Math.min(1, score + 0.08);
    else if (entryPlatform !== 'all') score *= 0.85;
  }
  return Number(Math.min(1, score).toFixed(4));
}

function formatPlatforms(values) {
  const flattened = [];
  for (const val of values) {
    for (const part of String(val || '').split(',')) {
      const clean = part.trim();
      if (clean) flattened.push(clean);
    }
  }
  const unique = [...new Set(flattened)];
  if (unique.length === 0) return 'unknown';
  return unique.sort().join(',');
}

export function openShadowStore(file, { readOnly = false } = {}) {
  if (!readOnly && file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file, { timeout: BUSY_TIMEOUT_MS, ...(readOnly ? { readOnly: true } : {}) });
  db.exec('PRAGMA foreign_keys = ON;');
  if (!readOnly) {
    db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS inbox (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('comment', 'dm')),
        platform TEXT NOT NULL,
        account_id TEXT,
        account_name TEXT,
        session_id TEXT,
        work_id TEXT,
        work_title TEXT,
        author_name TEXT,
        author_id TEXT,
        content TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        received_at TEXT NOT NULL,
        raw_json TEXT,
        processed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_inbox_pending ON inbox (processed_at, occurred_at, id);

      CREATE TABLE IF NOT EXISTS kb_entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        question TEXT NOT NULL,
        answer TEXT NOT NULL,
        platform TEXT NOT NULL DEFAULT 'all',
        source_card_id INTEGER,
        auto_reply INTEGER NOT NULL DEFAULT 0 CHECK (auto_reply = 0),
        keywords TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_kb_platform ON kb_entries (platform, updated_at);

      CREATE TABLE IF NOT EXISTS cards (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        card_type TEXT NOT NULL CHECK (card_type IN ('comment', 'dm', 'aggregate')),
        platform TEXT NOT NULL,
        account TEXT,
        question_summary TEXT NOT NULL,
        suggested_reply TEXT,
        topic_key TEXT,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'answered', 'skipped', 'expired')),
        final_answer TEXT,
        kb_entry_id INTEGER,
        notified_at TEXT,
        notify_version INTEGER NOT NULL DEFAULT 1,
        notify_claim_token TEXT,
        notify_claimed_at TEXT,
        notify_state TEXT CHECK (notify_state IS NULL OR notify_state IN ('uncertain')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        resolved_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_cards_status ON cards (status, created_at);
      CREATE INDEX IF NOT EXISTS idx_cards_topic ON cards (status, topic_key);

      CREATE TABLE IF NOT EXISTS card_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
        inbox_id TEXT NOT NULL UNIQUE REFERENCES inbox(id) ON DELETE CASCADE,
        platform TEXT,
        account TEXT,
        author_name TEXT,
        excerpt TEXT,
        created_at TEXT NOT NULL,
        UNIQUE (card_id, inbox_id)
      );
      CREATE INDEX IF NOT EXISTS idx_card_items_card ON card_items (card_id);

      CREATE TABLE IF NOT EXISTS shadow_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        inbox_id TEXT NOT NULL UNIQUE REFERENCES inbox(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        platform TEXT NOT NULL,
        decision TEXT NOT NULL CHECK (decision IN ('hit', 'new_question', 'ad', 'skip')),
        kb_entry_id INTEGER,
        card_id INTEGER,
        would_reply TEXT,
        reason TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_shadow_decision ON shadow_log (decision, created_at);

      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);

    const cardCols = new Set(db.prepare('PRAGMA table_info(cards)').all().map((c) => c.name));
    if (!cardCols.has('notify_version')) db.exec('ALTER TABLE cards ADD COLUMN notify_version INTEGER NOT NULL DEFAULT 1');
    if (!cardCols.has('notify_claim_token')) db.exec('ALTER TABLE cards ADD COLUMN notify_claim_token TEXT');
    if (!cardCols.has('notify_claimed_at')) db.exec('ALTER TABLE cards ADD COLUMN notify_claimed_at TEXT');
    if (!cardCols.has('notify_state')) db.exec("ALTER TABLE cards ADD COLUMN notify_state TEXT CHECK (notify_state IS NULL OR notify_state IN ('uncertain'))");

    // 兼容旧版库迁移：清理同一 inbox_id 绑定多张卡的历史脏数据，并补建 UNIQUE 索引防止重复入库
    const dupInboxes = db.prepare(`
      SELECT inbox_id FROM card_items GROUP BY inbox_id HAVING COUNT(*) > 1
    `).all();
    if (dupInboxes.length > 0) {
      const nowAt = new Date().toISOString();
      db.exec('BEGIN IMMEDIATE');
      try {
        const listRows = db.prepare(`
          SELECT ci.id AS item_id, ci.card_id, c.status
          FROM card_items ci
          JOIN cards c ON c.id = ci.card_id
          WHERE ci.inbox_id = ?
          ORDER BY CASE c.status
            WHEN 'answered' THEN 0
            WHEN 'skipped' THEN 1
            WHEN 'expired' THEN 2
            ELSE 3
          END, c.id ASC, ci.id ASC
        `);
        const delItem = db.prepare('DELETE FROM card_items WHERE id = ?');
        const fixShadow = db.prepare("UPDATE shadow_log SET card_id = ? WHERE inbox_id = ? AND decision = 'new_question'");
        const affectedCardIds = new Set();
        for (const { inbox_id: inboxId } of dupInboxes) {
          const linked = listRows.all(inboxId);
          const keeper = linked[0];
          for (let i = 1; i < linked.length; i += 1) {
            delItem.run(linked[i].item_id);
            affectedCardIds.add(linked[i].card_id);
          }
          if (keeper) fixShadow.run(keeper.card_id, inboxId);
        }
        const countCardItems = db.prepare('SELECT COUNT(*) AS n FROM card_items WHERE card_id = ?');
        const closeEmptyPending = db.prepare(`
          UPDATE cards SET status = 'skipped', resolved_at = COALESCE(resolved_at, ?), updated_at = ?
          WHERE id = ? AND status = 'pending'
        `);
        for (const cid of affectedCardIds) {
          if (countCardItems.get(cid).n === 0) closeEmptyPending.run(nowAt, nowAt, cid);
        }
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    }
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_card_items_inbox_unique ON card_items (inbox_id)');
  }

  function tx(fn) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  const toInboxView = (row) => ({
    id: row.id,
    kind: row.kind,
    platform: row.platform,
    accountId: row.account_id || null,
    accountName: row.account_name || null,
    sessionId: row.session_id || null,
    workId: row.work_id || null,
    workTitle: row.work_title || null,
    authorName: row.author_name || null,
    authorId: row.author_id || null,
    content: row.content,
    occurredAt: row.occurred_at,
    receivedAt: row.received_at,
    processedAt: row.processed_at || null,
  });

  const toKbView = (row) => ({
    id: row.id,
    question: row.question,
    answer: row.answer,
    platform: row.platform,
    sourceCardId: row.source_card_id ?? null,
    autoReply: false,
    keywords: row.keywords || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });

  function hydrateCards(rows) {
    if (rows.length === 0) return [];
    const itemsStmt = db.prepare(`
      SELECT ci.card_id, ci.inbox_id, ci.platform, ci.account, ci.author_name, ci.excerpt, ci.created_at,
             i.kind, i.work_title, i.occurred_at
      FROM card_items ci
      LEFT JOIN inbox i ON i.id = ci.inbox_id
      WHERE ci.card_id = ?
      ORDER BY ci.id ASC
    `);
    return rows.map((row) => ({
      id: row.id,
      cardType: row.card_type,
      platform: row.platform,
      account: row.account || null,
      questionSummary: row.question_summary,
      suggestedReply: row.suggested_reply || '',
      topicKey: row.topic_key || null,
      status: row.status,
      finalAnswer: row.final_answer || null,
      kbEntryId: row.kb_entry_id ?? null,
      notifiedAt: row.notified_at || null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      resolvedAt: row.resolved_at || null,
      items: itemsStmt.all(row.id).map((item) => ({
        inboxId: item.inbox_id,
        kind: item.kind || null,
        platform: item.platform || null,
        account: item.account || null,
        authorName: item.author_name || null,
        workTitle: item.work_title || null,
        excerpt: item.excerpt || '',
        occurredAt: item.occurred_at || null,
      })),
    }));
  }

  return {
    db,
    close: () => db.close(),

    /** 去重写入新评论/私信到 inbox，返回 { accepted, duplicate }。 */
    ingestInbox(items, { now = Date.now } = {}) {
      if (!Array.isArray(items)) throw new Error('ingestInbox 需要数组');
      const receivedAt = iso(now);
      const insert = db.prepare(`
        INSERT OR IGNORE INTO inbox (
          id, kind, platform, account_id, account_name, session_id, work_id, work_title,
          author_name, author_id, content, occurred_at, received_at, raw_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      let accepted = 0;
      tx(() => {
        for (const item of items) {
          if (!item || !nonEmpty(item.id)) throw new Error('inbox 条目缺少 id');
          if (item.kind !== 'comment' && item.kind !== 'dm') throw new Error(`无效 kind：${item.kind}`);
          if (!nonEmpty(item.platform)) throw new Error(`inbox 条目 ${item.id} 缺少 platform`);
          const content = String(item.content ?? '').trim();
          if (!content) continue;
          const occurredAt = item.occurredAt && !Number.isNaN(Date.parse(item.occurredAt))
            ? new Date(item.occurredAt).toISOString()
            : receivedAt;
          const changed = insert.run(
            item.id,
            item.kind,
            String(item.platform).trim(),
            item.accountId ? String(item.accountId) : null,
            item.accountName ? String(item.accountName) : null,
            item.sessionId ? String(item.sessionId) : null,
            item.workId ? String(item.workId) : null,
            item.workTitle ? String(item.workTitle) : null,
            item.authorName ? String(item.authorName) : null,
            item.authorId ? String(item.authorId) : null,
            content,
            occurredAt,
            receivedAt,
            item.raw ? JSON.stringify(item.raw) : null,
          ).changes;
          accepted += changed;
        }
      });
      return { accepted, duplicate: items.length - accepted };
    },

    pendingCount() {
      return db.prepare('SELECT COUNT(*) AS n FROM inbox WHERE processed_at IS NULL').get().n;
    },

    pendingItems(limit = PENDING_LIMIT) {
      const safeLimit = Math.max(1, Math.min(100, Number(limit) || PENDING_LIMIT));
      return db.prepare(`
        SELECT * FROM inbox
        WHERE processed_at IS NULL
        ORDER BY occurred_at ASC, id ASC
        LIMIT ?
      `).all(safeLimit).map(toInboxView);
    },

    getInbox(id) {
      const row = db.prepare('SELECT * FROM inbox WHERE id = ?').get(id);
      return row ? toInboxView(row) : null;
    },

    /** 问答库召回候选：返回匹配度排序后的候选列表，最终是否命中由 Cindy 判断。 */
    kbSearch({ query = '', platform = '', limit = 5 } = {}) {
      const safeLimit = Math.max(1, Math.min(20, Number(limit) || 5));
      const all = db.prepare('SELECT * FROM kb_entries ORDER BY updated_at DESC, id DESC').all();
      if (!nonEmpty(query)) {
        return all.slice(0, safeLimit).map((row) => ({ ...toKbView(row), score: 0 }));
      }
      const queryTerms = extractTerms(query);
      const scored = [];
      for (const row of all) {
        const score = scoreKbMatch(query, queryTerms, row, platform);
        if (score > 0) scored.push({ ...toKbView(row), score });
      }
      scored.sort((a, b) => b.score - a.score || b.id - a.id);
      return scored.slice(0, safeLimit);
    },

    listKb(limit = 200) {
      const safeLimit = Math.max(1, Math.min(1000, Number(limit) || 200));
      return db.prepare('SELECT * FROM kb_entries ORDER BY updated_at DESC, id DESC LIMIT ?').all(safeLimit).map(toKbView);
    },

    /** 提交新问题卡片；若已有相同 topicKey 或相同归一化摘要的 pending 卡片，自动合并为聚合卡。 */
    submitCard({ inboxIds, cardType, platform, account, questionSummary, suggestedReply = '', topicKey }, { now = Date.now } = {}) {
      if (!Array.isArray(inboxIds) || inboxIds.length === 0) throw new Error('card_submit 需要至少一条 inboxIds');
      if (!nonEmpty(questionSummary)) throw new Error('card_submit 缺少 questionSummary');
      if (cardType && !CARD_TYPES.includes(cardType)) throw new Error(`无效 cardType：${cardType}`);

      const uniqueIds = [...new Set(inboxIds.map((id) => String(id).trim()).filter(Boolean))];
      if (uniqueIds.length === 0) throw new Error('inboxIds 不能为空');

      const at = iso(now);
      const normTopic = nonEmpty(topicKey) ? normalizeText(topicKey) : null;
      const cleanSummary = questionSummary.trim();
      const cleanSuggested = String(suggestedReply || '').trim();

      const outcome = tx(() => {
        const rows = [];
        const getStmt = db.prepare('SELECT * FROM inbox WHERE id = ?');
        const getItemCardStmt = db.prepare(`
          SELECT ci.card_id, c.status
          FROM card_items ci
          JOIN cards c ON c.id = ci.card_id
          WHERE ci.inbox_id = ?
        `);
        const getShadowStmt = db.prepare('SELECT decision, card_id FROM shadow_log WHERE inbox_id = ?');

        const existingPendingCardIds = new Set();
        for (const id of uniqueIds) {
          const row = getStmt.get(id);
          if (!row) throw new Error(`inbox 中不存在该条记录：${id}`);
          const linked = getItemCardStmt.get(id);
          if (linked) {
            if (linked.status !== 'pending') {
              throw new Error(`inbox ${id} 已在卡片 #${linked.card_id}（${linked.status}）处理完毕，禁止重复出卡`);
            }
            existingPendingCardIds.add(linked.card_id);
          } else if (row.processed_at) {
            const shadowRow = getShadowStmt.get(id);
            const detail = shadowRow ? `已登记为 ${shadowRow.decision}` : '已标记处理完成';
            throw new Error(`inbox ${id} ${detail}，禁止重复出卡`);
          }
          rows.push(row);
        }

        if (existingPendingCardIds.size > 1) {
          throw new Error('所选 inboxIds 分属多张已存在的待处理卡片，请分别处理');
        }

        let existing = null;
        if (existingPendingCardIds.size === 1) {
          const [linkedId] = [...existingPendingCardIds];
          existing = db.prepare("SELECT * FROM cards WHERE id = ? AND status = 'pending'").get(linkedId);
        }
        if (!existing && normTopic) {
          existing = db.prepare("SELECT * FROM cards WHERE status = 'pending' AND topic_key = ? ORDER BY id ASC LIMIT 1").get(normTopic);
        }
        if (!existing) {
          const pendingCards = db.prepare("SELECT * FROM cards WHERE status = 'pending' ORDER BY id ASC").all();
          const targetNorm = normalizeText(cleanSummary);
          existing = pendingCards.find((card) => normalizeText(card.question_summary) === targetNorm) || null;
        }

        let targetCardId;
        let merged = false;
        if (existing) {
          targetCardId = existing.id;
          merged = true;
        } else {
          const inferredPlatform = nonEmpty(platform) ? platform.trim() : formatPlatforms(rows.map((r) => r.platform));
          const inferredAccount = nonEmpty(account) ? account.trim() : (rows.find((r) => r.account_name)?.account_name || rows[0].account_id || null);
          const inferredType = uniqueIds.length > 1
            ? 'aggregate'
            : (cardType || (rows[0].kind === 'dm' ? 'dm' : 'comment'));
          const res = db.prepare(`
            INSERT INTO cards (
              card_type, platform, account, question_summary, suggested_reply, topic_key,
              status, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
          `).run(inferredType, inferredPlatform, inferredAccount, cleanSummary, cleanSuggested, normTopic, at, at);
          targetCardId = Number(res.lastInsertRowid);
        }

        const insertItem = db.prepare(`
          INSERT OR IGNORE INTO card_items (card_id, inbox_id, platform, account, author_name, excerpt, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `);
        const insertShadow = db.prepare(`
          INSERT INTO shadow_log (inbox_id, kind, platform, decision, kb_entry_id, card_id, would_reply, reason, created_at)
          VALUES (?, ?, ?, 'new_question', NULL, ?, ?, ?, ?)
          ON CONFLICT(inbox_id) DO UPDATE SET card_id = excluded.card_id, would_reply = COALESCE(NULLIF(excluded.would_reply, ''), shadow_log.would_reply)
          WHERE shadow_log.decision = 'new_question'
        `);
        const markInbox = db.prepare('UPDATE inbox SET processed_at = COALESCE(processed_at, ?) WHERE id = ?');

        let addedItems = 0;
        for (const row of rows) {
          addedItems += insertItem.run(
            targetCardId,
            row.id,
            row.platform,
            row.account_name || row.account_id || null,
            row.author_name || null,
            row.content.slice(0, 240),
            at,
          ).changes;
          insertShadow.run(row.id, row.kind, row.platform, targetCardId, cleanSuggested || null, cleanSummary, at);
          markInbox.run(at, row.id);
        }

        if (merged) {
          const allItems = db.prepare('SELECT platform, account FROM card_items WHERE card_id = ?').all(targetCardId);
          const nextType = allItems.length > 1 ? 'aggregate' : existing.card_type;
          const nextPlatform = allItems.length > 0
            ? formatPlatforms(allItems.map((i) => i.platform))
            : formatPlatforms([existing.platform]);
          const nextSuggested = existing.suggested_reply || cleanSuggested;
          db.prepare(`
            UPDATE cards
            SET card_type = ?, platform = ?, suggested_reply = ?, updated_at = ?,
                notified_at = CASE WHEN ? > 0 THEN NULL ELSE notified_at END,
                notify_state = CASE WHEN ? > 0 THEN NULL ELSE notify_state END,
                notify_version = CASE WHEN ? > 0 THEN notify_version + 1 ELSE notify_version END,
                notify_claim_token = CASE WHEN ? > 0 THEN NULL ELSE notify_claim_token END,
                notify_claimed_at = CASE WHEN ? > 0 THEN NULL ELSE notify_claimed_at END
            WHERE id = ?
          `).run(nextType, nextPlatform, nextSuggested, at, addedItems, addedItems, addedItems, addedItems, addedItems, targetCardId);
        }

        return { cardId: targetCardId, merged, addedItems };
      });

      const card = this.getCard(outcome.cardId);
      return { card, merged: outcome.merged, addedItems: outcome.addedItems };
    },

    /** 记录影子判定（hit / new_question / ad / skip），并把 inbox 标为已处理。绝不触发任何真实回复。 */
    recordShadow(items, { now = Date.now } = {}) {
      if (!Array.isArray(items)) throw new Error('shadow_record 需要数组');
      const at = iso(now);
      let recorded = 0;
      let duplicate = 0;
      const rejected = [];

      tx(() => {
        const getInboxStmt = db.prepare('SELECT * FROM inbox WHERE id = ?');
        const getKbStmt = db.prepare('SELECT id FROM kb_entries WHERE id = ?');
        const getCardItemStmt = db.prepare('SELECT card_id FROM card_items WHERE card_id = ? AND inbox_id = ?');
        const insertShadow = db.prepare(`
          INSERT OR IGNORE INTO shadow_log (inbox_id, kind, platform, decision, kb_entry_id, card_id, would_reply, reason, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        const markInbox = db.prepare('UPDATE inbox SET processed_at = COALESCE(processed_at, ?) WHERE id = ?');

        for (const item of items) {
          if (!item || !nonEmpty(item.inboxId)) {
            rejected.push({ inboxId: item?.inboxId ?? null, reason: '缺少 inboxId' });
            continue;
          }
          if (!SHADOW_DECISIONS.includes(item.decision)) {
            rejected.push({ inboxId: item.inboxId, reason: `decision 必须是 ${SHADOW_DECISIONS.join('/')}` });
            continue;
          }
          const inboxRow = getInboxStmt.get(item.inboxId);
          if (!inboxRow) {
            rejected.push({ inboxId: item.inboxId, reason: 'inbox 中找不到该条记录' });
            continue;
          }
          let kbEntryId = item.kbEntryId != null ? Number(item.kbEntryId) : null;
          if (kbEntryId != null && (!Number.isInteger(kbEntryId) || !getKbStmt.get(kbEntryId))) {
            rejected.push({ inboxId: item.inboxId, reason: `kbEntryId 无效：${item.kbEntryId}` });
            continue;
          }
          if (item.decision === 'hit' && kbEntryId == null) {
            rejected.push({ inboxId: item.inboxId, reason: 'decision=hit 时必须提供有效的 kbEntryId' });
            continue;
          }
          let cardId = item.cardId != null ? Number(item.cardId) : null;
          if (item.decision === 'new_question') {
            if (cardId == null || !Number.isInteger(cardId) || !getCardItemStmt.get(cardId, inboxRow.id)) {
              rejected.push({ inboxId: item.inboxId, reason: 'decision=new_question 必须关联已通过 card_submit 绑定该 inboxId 的 cardId' });
              continue;
            }
          } else if (cardId != null && (!Number.isInteger(cardId) || !getCardItemStmt.get(cardId, inboxRow.id))) {
            rejected.push({ inboxId: item.inboxId, reason: `cardId 未绑定当前 inboxId：${item.cardId}` });
            continue;
          }
          if (item.wouldReply != null && typeof item.wouldReply !== 'string') {
            rejected.push({ inboxId: item.inboxId, reason: 'wouldReply 必须是字符串' });
            continue;
          }
          const wouldReply = typeof item.wouldReply === 'string' ? item.wouldReply.trim() : null;
          if (item.decision === 'hit' && !nonEmpty(wouldReply)) {
            rejected.push({ inboxId: item.inboxId, reason: 'decision=hit 时必须提供 wouldReply（本来会怎么回）' });
            continue;
          }
          if (item.reason != null && typeof item.reason !== 'string') {
            rejected.push({ inboxId: item.inboxId, reason: 'reason 必须是字符串' });
            continue;
          }
          const reason = typeof item.reason === 'string' ? item.reason.trim() : null;
          const changes = insertShadow.run(
            inboxRow.id,
            inboxRow.kind,
            inboxRow.platform,
            item.decision,
            kbEntryId,
            cardId,
            wouldReply,
            reason,
            at,
          ).changes;
          markInbox.run(at, inboxRow.id);
          if (changes > 0) recorded += 1;
          else duplicate += 1;
        }
      });

      return { recorded, duplicate, rejected };
    },

    getCard(id) {
      const row = db.prepare('SELECT * FROM cards WHERE id = ?').get(Number(id));
      return row ? hydrateCards([row])[0] : null;
    },

    listCards({ status = '', limit = 50 } = {}) {
      const safeLimit = Math.max(1, Math.min(200, Number(limit) || 50));
      const rows = status && CARD_STATUSES.includes(status)
        ? db.prepare('SELECT * FROM cards WHERE status = ? ORDER BY created_at DESC, id DESC LIMIT ?').all(status, safeLimit)
        : db.prepare("SELECT * FROM cards ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, created_at DESC, id DESC LIMIT ?").all(safeLimit);
      return hydrateCards(rows);
    },

    unnotifiedPendingCards(limit = 20) {
      const rows = db.prepare(`
        SELECT * FROM cards
        WHERE status = 'pending' AND notified_at IS NULL AND notify_state IS NULL
        ORDER BY created_at ASC, id ASC
        LIMIT ?
      `).all(Math.max(1, Math.min(50, Number(limit) || 20)));
      return hydrateCards(rows);
    },

    unnotifiedPendingCount() {
      return db.prepare("SELECT COUNT(*) AS n FROM cards WHERE status = 'pending' AND notified_at IS NULL AND notify_state IS NULL").get().n;
    },

    /** 原子认领一批待通知卡片，防止并发 cards_notify 重复推送，并携带 notify_version 防止覆盖新合并问题。 */
    claimUnnotifiedCards(limit = 20, { claimTtlMs = 60_000, now = Date.now } = {}) {
      const nowMs = typeof now === 'function' ? now() : now;
      const at = new Date(nowMs).toISOString();
      const cutoff = new Date(nowMs - Math.max(5_000, Number(claimTtlMs) || 60_000)).toISOString();
      const claimToken = crypto.randomBytes(12).toString('hex');
      const safeLimit = Math.max(1, Math.min(50, Number(limit) || 20));

      const claimedRows = tx(() => {
        const rows = db.prepare(`
          SELECT * FROM cards
          WHERE status = 'pending'
            AND notified_at IS NULL
            AND notify_state IS NULL
            AND (notify_claimed_at IS NULL OR notify_claimed_at < ?)
          ORDER BY created_at ASC, id ASC
          LIMIT ?
        `).all(cutoff, safeLimit);
        if (rows.length === 0) return [];
        const claimStmt = db.prepare(`
          UPDATE cards
          SET notify_claim_token = ?, notify_claimed_at = ?
          WHERE id = ? AND status = 'pending' AND notified_at IS NULL AND notify_state IS NULL
            AND (notify_claimed_at IS NULL OR notify_claimed_at < ?)
        `);
        const locked = [];
        for (const row of rows) {
          if (claimStmt.run(claimToken, at, row.id, cutoff).changes > 0) locked.push(row);
        }
        return locked;
      });

      const cards = hydrateCards(claimedRows).map((card, idx) => ({
        ...card,
        notifyVersion: claimedRows[idx].notify_version ?? 1,
      }));
      return { claimToken, cards };
    },

    /** 仅对仍在当前认领批次且版本未发生合并变更的卡片标记已通知。 */
    confirmCardsNotified(claimToken, cardVersions, { now = Date.now } = {}) {
      const at = iso(now);
      let confirmed = 0;
      const stmt = db.prepare(`
        UPDATE cards
        SET notified_at = ?, notify_state = NULL, notify_claim_token = NULL, notify_claimed_at = NULL
        WHERE id = ? AND status = 'pending' AND notified_at IS NULL
          AND notify_claim_token = ? AND notify_version = ?
      `);
      tx(() => {
        for (const entry of cardVersions) {
          confirmed += stmt.run(at, Number(entry.id), claimToken, Number(entry.notifyVersion)).changes;
        }
      });
      return confirmed;
    },

    /** 请求已发出但回执丢失/不可解析：fail-closed 标记 notify_state=uncertain，绝不误记已通知也不自动重发同版本。 */
    markNotifyUncertain(claimToken, cardVersions, { now = Date.now } = {}) {
      const at = iso(now);
      let marked = 0;
      const stmt = db.prepare(`
        UPDATE cards
        SET notify_state = 'uncertain', notify_claim_token = NULL, notify_claimed_at = NULL, updated_at = ?
        WHERE id = ? AND status = 'pending' AND notified_at IS NULL
          AND notify_claim_token = ? AND notify_version = ?
      `);
      tx(() => {
        for (const entry of cardVersions) {
          marked += stmt.run(at, Number(entry.id), claimToken, Number(entry.notifyVersion)).changes;
        }
      });
      return marked;
    },

    /** 通知发送失败时释放认领锁，便于后续重试。 */
    releaseNotifyClaim(claimToken) {
      tx(() => {
        db.prepare('UPDATE cards SET notify_claim_token = NULL, notify_claimed_at = NULL WHERE notify_claim_token = ?').run(claimToken);
      });
    },

    markCardsNotified(cardIds, { now = Date.now } = {}) {
      const at = iso(now);
      const stmt = db.prepare('UPDATE cards SET notified_at = ?, notify_claim_token = NULL, notify_claimed_at = NULL WHERE id = ? AND notified_at IS NULL');
      tx(() => {
        for (const id of cardIds) stmt.run(at, Number(id));
      });
    },

    /** Kinso 在本机答题页保存答案：写入 kb_entries（auto_reply 强制 0），卡片标 answered。 */
    answerCard(cardId, { answer, question, platform, keywords = '' }, { now = Date.now, kbExportFile = null } = {}) {
      if (!nonEmpty(answer)) throw new Error('答案不能为空');
      let safeExportPath = null;
      if (kbExportFile) {
        safeExportPath = assertSafeKbExportPath(kbExportFile);
        const exportDir = path.dirname(safeExportPath);
        fs.mkdirSync(exportDir, { recursive: true });
        fs.accessSync(exportDir, fs.constants.W_OK);
      }
      const at = iso(now);
      const result = tx(() => {
        const card = db.prepare('SELECT * FROM cards WHERE id = ?').get(Number(cardId));
        if (!card) return { ok: false, code: 404, error: '找不到这张卡片' };
        if (card.status !== 'pending') return { ok: false, code: 409, error: `卡片已处理（当前状态：${card.status}）` };

        const dupAnswered = db.prepare(`
          SELECT ci1.inbox_id, c2.id AS other_card_id
          FROM card_items ci1
          JOIN card_items ci2 ON ci2.inbox_id = ci1.inbox_id AND ci2.card_id != ci1.card_id
          JOIN cards c2 ON c2.id = ci2.card_id AND c2.status = 'answered'
          WHERE ci1.card_id = ?
          LIMIT 1
        `).get(card.id);
        if (dupAnswered) {
          return { ok: false, code: 409, error: `该卡关联的问题已在卡片 #${dupAnswered.other_card_id} 回答入库，禁止重复生成问答条目` };
        }

        const kbQuestion = nonEmpty(question) ? question.trim() : card.question_summary;
        const kbPlatform = nonEmpty(platform) ? platform.trim() : (card.platform || 'all');
        const cleanAnswer = answer.trim();
        const kbInsert = db.prepare(`
          INSERT INTO kb_entries (question, answer, platform, source_card_id, auto_reply, keywords, created_at, updated_at)
          VALUES (?, ?, ?, ?, 0, ?, ?, ?)
        `).run(kbQuestion, cleanAnswer, kbPlatform, card.id, String(keywords || '').trim(), at, at);
        const kbEntryId = Number(kbInsert.lastInsertRowid);

        db.prepare(`
          UPDATE cards
          SET status = 'answered', final_answer = ?, kb_entry_id = ?, resolved_at = ?, updated_at = ?
          WHERE id = ?
        `).run(cleanAnswer, kbEntryId, at, at, card.id);
        return { ok: true, kbEntryId, cardId: card.id };
      });

      if (!result.ok) return result;
      let exportedTo = null;
      let exportWarning = null;
      if (safeExportPath) {
        try {
          exportedTo = this.exportKbMarkdown(safeExportPath, { now });
        } catch (err) {
          exportWarning = `答案已入问答库，但只读镜像导出失败：${err.code || err.message}`;
        }
      }
      return {
        ok: true,
        card: this.getCard(result.cardId),
        kbEntry: toKbView(db.prepare('SELECT * FROM kb_entries WHERE id = ?').get(result.kbEntryId)),
        exportedTo,
        ...(exportWarning ? { exportWarning } : {}),
      };
    },

    skipCard(cardId, { now = Date.now } = {}) {
      const at = iso(now);
      const result = tx(() => {
        const card = db.prepare('SELECT * FROM cards WHERE id = ?').get(Number(cardId));
        if (!card) return { ok: false, code: 404, error: '找不到这张卡片' };
        if (card.status !== 'pending') return { ok: false, code: 409, error: `卡片已处理（当前状态：${card.status}）` };
        db.prepare("UPDATE cards SET status = 'skipped', resolved_at = ?, updated_at = ? WHERE id = ?").run(at, at, card.id);
        return { ok: true, cardId: card.id };
      });
      if (!result.ok) return result;
      return { ok: true, card: this.getCard(result.cardId) };
    },

    expireCard(cardId, { now = Date.now } = {}) {
      const at = iso(now);
      const result = tx(() => {
        const card = db.prepare('SELECT * FROM cards WHERE id = ?').get(Number(cardId));
        if (!card) return { ok: false, code: 404, error: '找不到这张卡片' };
        if (card.status !== 'pending') return { ok: false, code: 409, error: `卡片已处理（当前状态：${card.status}）` };
        db.prepare("UPDATE cards SET status = 'expired', resolved_at = ?, updated_at = ? WHERE id = ?").run(at, at, card.id);
        return { ok: true, cardId: card.id };
      });
      if (!result.ok) return result;
      return { ok: true, card: this.getCard(result.cardId) };
    },

    listShadowLog(limit = 50) {
      return db.prepare('SELECT * FROM shadow_log ORDER BY id DESC LIMIT ?').all(Math.max(1, Math.min(200, Number(limit) || 50))).map((row) => ({
        id: row.id,
        inboxId: row.inbox_id,
        kind: row.kind,
        platform: row.platform,
        decision: row.decision,
        kbEntryId: row.kb_entry_id ?? null,
        cardId: row.card_id ?? null,
        wouldReply: row.would_reply || null,
        reason: row.reason || null,
        createdAt: row.created_at,
      }));
    },

    stats() {
      const inbox = db.prepare(`
        SELECT COUNT(*) AS total,
               COALESCE(SUM(processed_at IS NULL), 0) AS pending,
               COALESCE(SUM(processed_at IS NOT NULL), 0) AS processed
        FROM inbox
      `).get();
      const cards = db.prepare(`
        SELECT COUNT(*) AS total,
               COALESCE(SUM(status = 'pending'), 0) AS pending,
               COALESCE(SUM(status = 'answered'), 0) AS answered,
               COALESCE(SUM(status = 'skipped'), 0) AS skipped,
               COALESCE(SUM(status = 'expired'), 0) AS expired
        FROM cards
      `).get();
      const shadow = db.prepare(`
        SELECT COUNT(*) AS total,
               COALESCE(SUM(decision = 'hit'), 0) AS hit,
               COALESCE(SUM(decision = 'new_question'), 0) AS newQuestion,
               COALESCE(SUM(decision = 'ad'), 0) AS ad,
               COALESCE(SUM(decision = 'skip'), 0) AS skip
        FROM shadow_log
      `).get();
      const kb = db.prepare('SELECT COUNT(*) AS total FROM kb_entries').get();
      return {
        inbox: { ...inbox },
        cards: { ...cards },
        shadow: { ...shadow },
        kb: { total: kb.total, autoReplyEnabled: 0 },
      };
    },

    getMeta(key) {
      const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
      return row ? row.value : null;
    },

    setMeta(key, value) {
      db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, String(value));
    },

    /** 导出问答库只读镜像到 Markdown（原子写入，先校验路径绝不碰 OpenBot 文件或符号链接）。 */
    exportKbMarkdown(filePath, { now = Date.now } = {}) {
      const safePath = assertSafeKbExportPath(filePath);
      const entries = db.prepare('SELECT * FROM kb_entries ORDER BY id DESC').all().map(toKbView);
      const updatedAt = iso(now);
      const lines = [
        '---',
        'title: 小V猫问答库（只读镜像）',
        'type: 问答库镜像',
        'status: 影子期（自动回复关闭）',
        `updated: ${updatedAt}`,
        `entries: ${entries.length}`,
        '---',
        '',
        '# 小V猫问答库（只读镜像）',
        '',
        '> 本文件由 `integrations/vcat/store.mjs` 自动从 `integrations/vcat/data/shadow.db` 导出，仅作只读查阅镜像；请在本机答题页维护答案，不要手工编辑本文件。影子期所有条目 `autoReply=false`，不会触发任何平台回复。',
        '',
      ];
      if (entries.length === 0) {
        lines.push('暂无问答条目。', '');
      } else {
        for (const entry of entries) {
          lines.push(`## #${entry.id} ${entry.question}`);
          lines.push(`- 平台：${entry.platform}`);
          lines.push(`- 来源卡片：${entry.sourceCardId != null ? `#${entry.sourceCardId}` : '手动/无'}`);
          lines.push('- 自动回复：关闭（影子期 `autoReply=false`）');
          lines.push(`- 更新时间：${entry.updatedAt}`);
          if (entry.keywords) lines.push(`- 关键词：${entry.keywords}`);
          lines.push('');
          lines.push(entry.answer);
          lines.push('');
        }
      }
      fs.mkdirSync(path.dirname(safePath), { recursive: true });
      const tmp = path.join(path.dirname(safePath), `.vcat-kb-${process.pid}-${crypto.randomBytes(6).toString('hex')}.tmp`);
      const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o644);
      try {
        fs.writeFileSync(fd, lines.join('\n'), 'utf8');
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmp, safePath);
      return safePath;
    },
  };
}
