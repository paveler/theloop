/**
 * SQLite storage of the example harness (node:sqlite, no dependencies). Everything durable
 * lives here, none of it in the engine: sessions, the message history, runs, operations of
 * write tools and the demo business data (orders).
 *
 * Writes are idempotent by deterministic ids (SPEC §3.1 rule 5): a run by run_id, a message by
 * `<run_id>:<seq>`, a tool result by call_id, an operation by a hash of its origin.
 */
import { DatabaseSync } from 'node:sqlite'

export type SessionState = 'idle' | 'running' | 'awaiting_tool'

export interface Session {
  id: string
  user_id: string
  state: SessionState
  history_revision: number
  active_run_id: string | null
  pending_call_ids: string[]
  /** `event` parts for the next user message: late operation results after a supersede. */
  pending_events: Array<{ type: 'event'; name: string; data: unknown }>
}

export interface RunRow {
  id: string
  session_id: string
  status: string
  deadline_at: number
  acked: boolean
  /** The recorded result, once one arrived. */
  result: unknown
}

export type OperationStatus = 'pending' | 'done' | 'rejected'

export interface Operation {
  id: string
  session_id: string
  tool: string
  status: OperationStatus
  fields: { orderId: string; amount: number }
  version: number
  result: unknown
}

export interface Order {
  id: string
  user_id: string
  status: string
  total: number
  refunded: number
}

export type Store = ReturnType<typeof openStore>

export function openStore(path = ':memory:') {
  const db = new DatabaseSync(path)
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'idle',
      history_revision INTEGER NOT NULL DEFAULT 0, active_run_id TEXT,
      pending_call_ids TEXT NOT NULL DEFAULT '[]', pending_events TEXT NOT NULL DEFAULT '[]');
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, position INTEGER NOT NULL,
      payload TEXT NOT NULL, audit INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, status TEXT NOT NULL,
      deadline_at INTEGER NOT NULL, result TEXT, acked INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS operations (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, tool TEXT NOT NULL, status TEXT NOT NULL,
      fields TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, result TEXT);
    CREATE TABLE IF NOT EXISTS oprefs (id TEXT PRIMARY KEY, operation_id TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, status TEXT NOT NULL,
      total REAL NOT NULL, refunded REAL NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS refunds (operation_id TEXT PRIMARY KEY, order_id TEXT NOT NULL, amount REAL NOT NULL);
  `)

  const sessionFrom = (row: Record<string, unknown>): Session => ({
    id: String(row.id),
    user_id: String(row.user_id),
    state: row.state as SessionState,
    history_revision: Number(row.history_revision),
    active_run_id: (row.active_run_id as string | null) ?? null,
    pending_call_ids: JSON.parse(String(row.pending_call_ids)),
    pending_events: JSON.parse(String(row.pending_events)),
  })

  const operationFrom = (row: Record<string, unknown>): Operation => ({
    id: String(row.id),
    session_id: String(row.session_id),
    tool: String(row.tool),
    status: row.status as OperationStatus,
    fields: JSON.parse(String(row.fields)),
    version: Number(row.version),
    result: row.result == null ? null : JSON.parse(String(row.result)),
  })

  return {
    db,

    transaction<T>(fn: () => T): T {
      db.exec('BEGIN')
      try {
        const out = fn()
        db.exec('COMMIT')
        return out
      } catch (err) {
        db.exec('ROLLBACK')
        throw err
      }
    },

    /* ------------------------------------------------------------ sessions */

    session(id: string, userId: string): Session {
      db.prepare('INSERT OR IGNORE INTO sessions (id, user_id) VALUES (?, ?)').run(id, userId)
      return sessionFrom(db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as Record<string, unknown>)
    },

    saveSession(s: Session): void {
      db.prepare(
        `UPDATE sessions SET state = ?, history_revision = ?, active_run_id = ?, pending_call_ids = ?,
         pending_events = ? WHERE id = ?`,
      ).run(s.state, s.history_revision, s.active_run_id, JSON.stringify(s.pending_call_ids), JSON.stringify(s.pending_events), s.id)
    },

    /* ------------------------------------------------------------ messages */

    /** Upsert by id: a second write of the same message is a no-op, its position is kept. */
    putMessage(id: string, sessionId: string, payload: unknown, audit = false): void {
      const next = db.prepare('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM messages WHERE session_id = ?').get(sessionId) as { p: number }
      db.prepare('INSERT OR IGNORE INTO messages (id, session_id, position, payload, audit) VALUES (?, ?, ?, ?, ?)').run(
        id,
        sessionId,
        next.p,
        JSON.stringify(payload),
        audit ? 1 : 0,
      )
    },

    /** The history sent to the engine: every non-audit message, in order (SPEC §5). */
    history(sessionId: string): Array<Record<string, any>> {
      const rows = db
        .prepare('SELECT payload FROM messages WHERE session_id = ? AND audit = 0 ORDER BY position')
        .all(sessionId) as Array<{ payload: string }>
      return rows.map((r) => JSON.parse(r.payload))
    },

    /* ---------------------------------------------------------------- runs */

    putRun(id: string, sessionId: string, deadlineAt: number): void {
      db.prepare("INSERT OR IGNORE INTO runs (id, session_id, status, deadline_at) VALUES (?, ?, 'running', ?)").run(id, sessionId, deadlineAt)
    },

    run(id: string): RunRow | null {
      const row = db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as Record<string, unknown> | undefined
      if (!row) return null
      return {
        id: String(row.id),
        session_id: String(row.session_id),
        status: String(row.status),
        deadline_at: Number(row.deadline_at),
        acked: Number(row.acked) === 1,
        result: row.result == null ? null : JSON.parse(String(row.result)),
      }
    },

    /** An upsert: a callback may arrive before the POST /runs response created the row. */
    setRunResult(id: string, sessionId: string, status: string, result: unknown): void {
      db.prepare(
        `INSERT INTO runs (id, session_id, status, deadline_at, result) VALUES (?, ?, ?, 0, ?)
         ON CONFLICT(id) DO UPDATE SET status = excluded.status, result = excluded.result`,
      ).run(id, sessionId, status, JSON.stringify(result))
    },

    setRunStatus(id: string, status: string, deadlineAt?: number): void {
      if (deadlineAt != null) db.prepare('UPDATE runs SET status = ?, deadline_at = ? WHERE id = ?').run(status, deadlineAt, id)
      else db.prepare('UPDATE runs SET status = ? WHERE id = ?').run(status, id)
    },

    markAcked(id: string): void {
      db.prepare('UPDATE runs SET acked = 1 WHERE id = ?').run(id)
    },

    overdueRuns(now: number): RunRow[] {
      const rows = db.prepare("SELECT id FROM runs WHERE status = 'running' AND deadline_at < ?").all(now) as Array<{ id: string }>
      return rows.map((r) => this.run(r.id)!)
    },

    /* ---------------------------------------------------------- operations */

    operation(id: string): Operation | null {
      const row = db.prepare('SELECT * FROM operations WHERE id = ?').get(id) as Record<string, unknown> | undefined
      return row ? operationFrom(row) : null
    },

    operationByRef(refId: string): Operation | null {
      const ref = db.prepare('SELECT operation_id FROM oprefs WHERE id = ?').get(refId) as { operation_id: string } | undefined
      return ref ? this.operation(ref.operation_id) : null
    },

    pendingOperations(sessionId: string, tool?: string): Operation[] {
      const rows = (
        tool
          ? db.prepare("SELECT * FROM operations WHERE session_id = ? AND tool = ? AND status = 'pending'").all(sessionId, tool)
          : db.prepare("SELECT * FROM operations WHERE session_id = ? AND status = 'pending'").all(sessionId)
      ) as Array<Record<string, unknown>>
      return rows.map(operationFrom)
    },

    putOperation(op: Operation): void {
      db.prepare(
        `INSERT INTO operations (id, session_id, tool, status, fields, version, result) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET status = excluded.status, fields = excluded.fields,
         version = excluded.version, result = excluded.result`,
      ).run(op.id, op.session_id, op.tool, op.status, JSON.stringify(op.fields), op.version, op.result == null ? null : JSON.stringify(op.result))
    },

    putOpref(refId: string, operationId: string): void {
      db.prepare('INSERT OR IGNORE INTO oprefs (id, operation_id) VALUES (?, ?)').run(refId, operationId)
    },

    /* ------------------------------------------------------- demo business */

    putOrder(order: Order): void {
      db.prepare('INSERT OR IGNORE INTO orders (id, user_id, status, total, refunded) VALUES (?, ?, ?, ?, ?)').run(
        order.id,
        order.user_id,
        order.status,
        order.total,
        order.refunded,
      )
    },

    order(id: string, userId: string): Order | null {
      const row = db.prepare('SELECT * FROM orders WHERE id = ? AND user_id = ?').get(id, userId) as Record<string, unknown> | undefined
      if (!row) return null
      return {
        id: String(row.id),
        user_id: String(row.user_id),
        status: String(row.status),
        total: Number(row.total),
        refunded: Number(row.refunded),
      }
    },

    /** The downstream mutation, idempotent by operation id — as a payment provider would be. */
    refund(operationId: string, orderId: string, amount: number): void {
      const inserted = db.prepare('INSERT OR IGNORE INTO refunds (operation_id, order_id, amount) VALUES (?, ?, ?)').run(operationId, orderId, amount)
      if (Number(inserted.changes) === 0) return
      db.prepare("UPDATE orders SET refunded = refunded + ?, status = 'refunded' WHERE id = ?").run(amount, orderId)
    },
  }
}
