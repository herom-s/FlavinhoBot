import type {
  AuditEntry,
  ChatInfo,
  AuditEvent,
  JoinRequestRecord,
  MemberRecord,
  MemberStatus,
  OAuthStateRecord,
  OverrideRecord,
  Repository,
  SeenMemberRecord,
} from "./repository";

interface MemberRow {
  telegram_id: number;
  telegram_username: string | null;
  intra_id: number;
  intra_login: string;
  status: string;
  campus_id: number | null;
  verified_at: string;
  last_checked_at: string;
  consent_at: string;
  revoked_reason: string | null;
}

interface JoinRequestRow {
  telegram_id: number;
  chat_id: number;
  requested_at: string;
}

interface StateRow {
  telegram_id: number;
  telegram_username: string | null;
  chat_ids: string;
  created_at: string;
  expires_at: string;
}

const toMember = (r: MemberRow): MemberRecord => ({
  telegramId: r.telegram_id,
  telegramUsername: r.telegram_username,
  intraId: r.intra_id,
  intraLogin: r.intra_login,
  status: r.status as MemberStatus,
  campusId: r.campus_id,
  verifiedAt: r.verified_at,
  lastCheckedAt: r.last_checked_at,
  consentAt: r.consent_at,
  revokedReason: r.revoked_reason,
});

const toJoinRequest = (r: JoinRequestRow): JoinRequestRecord => ({
  telegramId: r.telegram_id,
  chatId: r.chat_id,
  requestedAt: r.requested_at,
});

const toState = (r: StateRow): OAuthStateRecord => ({
  telegramId: r.telegram_id,
  telegramUsername: r.telegram_username,
  chatIds: JSON.parse(r.chat_ids) as number[],
  createdAt: r.created_at,
  expiresAt: r.expires_at,
});

const MEMBER_COLS =
  "telegram_id, telegram_username, intra_id, intra_login, status, campus_id, verified_at, last_checked_at, consent_at, revoked_reason";

export class D1Repository implements Repository {
  constructor(private readonly db: D1Database) {}

  private async member(where: string, value: unknown): Promise<MemberRecord | null> {
    const row = await this.db
      .prepare(`SELECT ${MEMBER_COLS} FROM members WHERE ${where} LIMIT 1`)
      .bind(value)
      .first<MemberRow>();
    return row ? toMember(row) : null;
  }

  getMember(telegramId: number) {
    return this.member("telegram_id = ?", telegramId);
  }
  getMemberByIntraId(intraId: number) {
    return this.member("intra_id = ?", intraId);
  }
  getMemberByLogin(login: string) {
    return this.member("intra_login = ? COLLATE NOCASE", login);
  }
  getMemberByUsername(username: string) {
    return this.member("telegram_username = ? COLLATE NOCASE", username);
  }

  async upsertMember(m: MemberRecord): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO members (${MEMBER_COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (telegram_id) DO UPDATE SET
           telegram_username = excluded.telegram_username,
           intra_id = excluded.intra_id,
           intra_login = excluded.intra_login,
           status = excluded.status,
           campus_id = excluded.campus_id,
           verified_at = excluded.verified_at,
           last_checked_at = excluded.last_checked_at,
           consent_at = excluded.consent_at,
           revoked_reason = excluded.revoked_reason`,
      )
      .bind(
        m.telegramId,
        m.telegramUsername,
        m.intraId,
        m.intraLogin,
        m.status,
        m.campusId,
        m.verifiedAt,
        m.lastCheckedAt,
        m.consentAt,
        m.revokedReason,
      )
      .run();
  }

  async updateMemberCheck(
    telegramId: number,
    checkedAt: string,
    status: MemberStatus | null,
    revokedReason: string | null,
  ): Promise<void> {
    await this.db
      .prepare(
        `UPDATE members SET last_checked_at = ?, status = COALESCE(?, status), revoked_reason = ?
         WHERE telegram_id = ?`,
      )
      .bind(checkedAt, status, revokedReason, telegramId)
      .run();
  }

  async listMembersToReverify(checkedBefore: string, limit: number): Promise<MemberRecord[]> {
    // Membros revogados não entram: já foram reportados e só voltam via /start ou /reverificar.
    const { results } = await this.db
      .prepare(
        `SELECT ${MEMBER_COLS} FROM members
         WHERE last_checked_at < ? AND revoked_reason IS NULL
         ORDER BY last_checked_at ASC LIMIT ?`,
      )
      .bind(checkedBefore, limit)
      .all<MemberRow>();
    return results.map(toMember);
  }

  async countMembersByStatus(): Promise<Record<string, number>> {
    const { results } = await this.db
      .prepare(
        `SELECT CASE WHEN revoked_reason IS NULL THEN status ELSE 'revogado' END AS s, COUNT(*) AS n
         FROM members GROUP BY s`,
      )
      .all<{ s: string; n: number }>();
    return Object.fromEntries(results.map((r) => [r.s, r.n]));
  }

  async isTelegramDenied(telegramId: number): Promise<boolean> {
    const row = await this.db
      .prepare(
        `SELECT 1 AS x FROM members m JOIN overrides o ON o.intra_login = m.intra_login COLLATE NOCASE
         WHERE m.telegram_id = ? AND o.type = 'deny' LIMIT 1`,
      )
      .bind(telegramId)
      .first<{ x: number }>();
    return row !== null;
  }

  async addJoinRequest(telegramId: number, chatId: number, requestedAt: string): Promise<void> {
    // Mantém a data original se o Telegram reenviar o update.
    await this.db
      .prepare(
        `INSERT INTO join_requests (telegram_id, chat_id, requested_at) VALUES (?, ?, ?)
         ON CONFLICT (telegram_id, chat_id) DO NOTHING`,
      )
      .bind(telegramId, chatId, requestedAt)
      .run();
  }

  async listJoinRequestsForUser(telegramId: number): Promise<JoinRequestRecord[]> {
    const { results } = await this.db
      .prepare("SELECT telegram_id, chat_id, requested_at FROM join_requests WHERE telegram_id = ?")
      .bind(telegramId)
      .all<JoinRequestRow>();
    return results.map(toJoinRequest);
  }

  async deleteJoinRequest(telegramId: number, chatId: number): Promise<void> {
    await this.db
      .prepare("DELETE FROM join_requests WHERE telegram_id = ? AND chat_id = ?")
      .bind(telegramId, chatId)
      .run();
  }

  async listJoinRequests(limit: number): Promise<JoinRequestRecord[]> {
    const { results } = await this.db
      .prepare(
        "SELECT telegram_id, chat_id, requested_at FROM join_requests ORDER BY requested_at ASC LIMIT ?",
      )
      .bind(limit)
      .all<JoinRequestRow>();
    return results.map(toJoinRequest);
  }

  async listJoinRequestsBefore(requestedBefore: string, limit: number) {
    const { results } = await this.db
      .prepare(
        `SELECT telegram_id, chat_id, requested_at FROM join_requests
         WHERE requested_at < ? ORDER BY requested_at ASC LIMIT ?`,
      )
      .bind(requestedBefore, limit)
      .all<JoinRequestRow>();
    return results.map(toJoinRequest);
  }

  async countJoinRequests(): Promise<number> {
    const row = await this.db
      .prepare("SELECT COUNT(*) AS n FROM join_requests")
      .first<{ n: number }>();
    return row?.n ?? 0;
  }

  async getOverride(login: string): Promise<OverrideRecord | null> {
    const row = await this.db
      .prepare(
        `SELECT intra_login, type, reason, added_by, added_at FROM overrides
         WHERE intra_login = ? COLLATE NOCASE`,
      )
      .bind(login)
      .first<{
        intra_login: string;
        type: "allow" | "deny";
        reason: string | null;
        added_by: number;
        added_at: string;
      }>();
    return row
      ? {
          intraLogin: row.intra_login,
          type: row.type,
          reason: row.reason,
          addedBy: row.added_by,
          addedAt: row.added_at,
        }
      : null;
  }

  async setOverride(o: Omit<OverrideRecord, "addedAt">, addedAt: string): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO overrides (intra_login, type, reason, added_by, added_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (intra_login) DO UPDATE SET
           type = excluded.type, reason = excluded.reason,
           added_by = excluded.added_by, added_at = excluded.added_at`,
      )
      .bind(o.intraLogin.toLowerCase(), o.type, o.reason, o.addedBy, addedAt)
      .run();
  }

  async audit(event: AuditEvent, e: AuditEntry, at: string): Promise<void> {
    await this.db
      .prepare(
        "INSERT INTO audit_log (event, telegram_id, intra_login, detail, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .bind(event, e.telegramId ?? null, e.intraLogin ?? null, e.detail ?? null, at)
      .run();
  }

  async countAuditSince(event: AuditEvent, since: string): Promise<number> {
    const row = await this.db
      .prepare("SELECT COUNT(*) AS n FROM audit_log WHERE event = ? AND created_at >= ?")
      .bind(event, since)
      .first<{ n: number }>();
    return row?.n ?? 0;
  }

  async purgeAudit(event: AuditEvent, before: string): Promise<number> {
    const res = await this.db
      .prepare("DELETE FROM audit_log WHERE event = ? AND created_at < ?")
      .bind(event, before)
      .run();
    return res.meta.changes ?? 0;
  }

  async deleteUserData(telegramId: number): Promise<void> {
    const member = await this.getMember(telegramId);
    const stmts = [
      this.db.prepare("DELETE FROM members WHERE telegram_id = ?").bind(telegramId),
      this.db.prepare("DELETE FROM join_requests WHERE telegram_id = ?").bind(telegramId),
      this.db.prepare("DELETE FROM seen_members WHERE telegram_id = ?").bind(telegramId),
      this.db.prepare("DELETE FROM oauth_states WHERE telegram_id = ?").bind(telegramId),
      this.db.prepare("DELETE FROM audit_log WHERE telegram_id = ?").bind(telegramId),
    ];
    if (member) {
      stmts.push(
        this.db
          .prepare("DELETE FROM audit_log WHERE intra_login = ? COLLATE NOCASE")
          .bind(member.intraLogin),
      );
    }
    await this.db.batch(stmts);
  }

  async saveOAuthState(stateHash: string, d: OAuthStateRecord): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO oauth_states (state_hash, telegram_id, telegram_username, chat_ids, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        stateHash,
        d.telegramId,
        d.telegramUsername,
        JSON.stringify(d.chatIds),
        d.createdAt,
        d.expiresAt,
      )
      .run();
  }

  async peekOAuthState(stateHash: string, now: string): Promise<OAuthStateRecord | null> {
    const row = await this.db
      .prepare(
        `SELECT telegram_id, telegram_username, chat_ids, created_at, expires_at FROM oauth_states
         WHERE state_hash = ? AND expires_at > ?`,
      )
      .bind(stateHash, now)
      .first<StateRow>();
    return row ? toState(row) : null;
  }

  async consumeOAuthState(stateHash: string, now: string): Promise<OAuthStateRecord | null> {
    const row = await this.db
      .prepare(
        `DELETE FROM oauth_states WHERE state_hash = ?
         RETURNING telegram_id, telegram_username, chat_ids, created_at, expires_at`,
      )
      .bind(stateHash)
      .first<StateRow>();
    if (!row || row.expires_at <= now) return null;
    return toState(row);
  }

  async purgeOAuthStates(now: string): Promise<number> {
    const res = await this.db
      .prepare("DELETE FROM oauth_states WHERE expires_at <= ?")
      .bind(now)
      .run();
    return res.meta.changes ?? 0;
  }

  async markSeen(
    telegramId: number,
    chatId: number,
    username: string | null,
    at: string,
  ): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO seen_members (telegram_id, chat_id, telegram_username, first_seen_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (telegram_id, chat_id) DO UPDATE SET telegram_username = excluded.telegram_username
         WHERE seen_members.telegram_username IS NOT excluded.telegram_username`,
      )
      .bind(telegramId, chatId, username, at)
      .run();
  }

  async listUnverifiedSeen(limit: number): Promise<SeenMemberRecord[]> {
    const { results } = await this.db
      .prepare(
        `SELECT s.telegram_id, MAX(s.telegram_username) AS telegram_username,
                GROUP_CONCAT(s.chat_id) AS chat_ids, MIN(s.first_seen_at) AS first_seen_at
         FROM seen_members s LEFT JOIN members m ON m.telegram_id = s.telegram_id
         WHERE m.telegram_id IS NULL OR m.revoked_reason IS NOT NULL
         GROUP BY s.telegram_id ORDER BY first_seen_at ASC LIMIT ?`,
      )
      .bind(limit)
      .all<{
        telegram_id: number;
        telegram_username: string | null;
        chat_ids: string;
        first_seen_at: string;
      }>();
    return results.map((r) => ({
      telegramId: r.telegram_id,
      telegramUsername: r.telegram_username,
      chatIds: String(r.chat_ids).split(",").map(Number),
      firstSeenAt: r.first_seen_at,
    }));
  }

  async deleteSeen(telegramId: number): Promise<void> {
    await this.db.prepare("DELETE FROM seen_members WHERE telegram_id = ?").bind(telegramId).run();
  }

  async upsertChat(chatId: number, title: string | null, at: string): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO chats (chat_id, title, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (chat_id) DO UPDATE SET title = excluded.title, updated_at = excluded.updated_at`,
      )
      .bind(chatId, title, at)
      .run();
  }

  async getChatTitles(chatIds: number[]): Promise<Map<number, string>> {
    if (chatIds.length === 0) return new Map();
    const { results } = await this.db
      .prepare(
        `SELECT chat_id, title FROM chats WHERE chat_id IN (${chatIds.map(() => "?").join(",")})`,
      )
      .bind(...chatIds)
      .all<{ chat_id: number; title: string | null }>();
    return new Map(results.filter((r) => r.title).map((r) => [r.chat_id, r.title as string]));
  }

  async setChatDescription(chatId: number, description: string | null, at: string) {
    await this.db
      .prepare(
        `INSERT INTO chats (chat_id, title, description, updated_at) VALUES (?, NULL, ?, ?)
         ON CONFLICT (chat_id) DO UPDATE SET description = excluded.description, updated_at = excluded.updated_at`,
      )
      .bind(chatId, description, at)
      .run();
  }

  async getChatInfo(chatIds: number[]): Promise<Map<number, ChatInfo>> {
    if (chatIds.length === 0) return new Map();
    const { results } = await this.db
      .prepare(
        `SELECT chat_id, title, description FROM chats WHERE chat_id IN (${chatIds.map(() => "?").join(",")})`,
      )
      .bind(...chatIds)
      .all<{ chat_id: number; title: string | null; description: string | null }>();
    return new Map(results.map((r) => [r.chat_id, { title: r.title, description: r.description }]));
  }

  async getSetting(key: string): Promise<string | null> {
    const row = await this.db
      .prepare("SELECT value FROM settings WHERE key = ?")
      .bind(key)
      .first<{ value: string }>();
    return row?.value ?? null;
  }

  async setSetting(key: string, value: string): Promise<void> {
    await this.db
      .prepare(
        "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      )
      .bind(key, value)
      .run();
  }
}
