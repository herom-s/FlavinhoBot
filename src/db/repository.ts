import type { AllowReason, OverrideType } from "../domain/eligibility";

export type MemberStatus = AllowReason; // 'cadete_ativo' | 'alumni' | 'staff' | 'override'

export interface MemberRecord {
  telegramId: number;
  telegramUsername: string | null;
  intraId: number;
  intraLogin: string;
  status: MemberStatus;
  campusId: number | null;
  verifiedAt: string;
  lastCheckedAt: string;
  consentAt: string;
  revokedReason: string | null;
}

export interface JoinRequestRecord {
  telegramId: number;
  chatId: number;
  requestedAt: string;
}

export interface OverrideRecord {
  intraLogin: string;
  type: OverrideType;
  reason: string | null;
  addedBy: number;
  addedAt: string;
}

export interface OAuthStateRecord {
  telegramId: number;
  telegramUsername: string | null;
  chatIds: number[];
  createdAt: string;
  expiresAt: string;
}

export interface SeenMemberRecord {
  telegramId: number;
  telegramUsername: string | null;
  chatIds: number[];
  firstSeenAt: string;
}

export interface AuditEntry {
  telegramId?: number | null;
  intraLogin?: string | null;
  detail?: string | null;
}

export type AuditEvent =
  | "verified"
  | "denied"
  | "approved"
  | "declined"
  | "removed"
  | "override"
  | "revoked"
  | "shared_account"
  | "data_deleted"
  | "expired_request";

/** Acesso a dados isolado atrás de uma interface (troca D1 ↔ Postgres sem mexer no resto). */
export interface Repository {
  // members
  getMember(telegramId: number): Promise<MemberRecord | null>;
  getMemberByIntraId(intraId: number): Promise<MemberRecord | null>;
  getMemberByLogin(login: string): Promise<MemberRecord | null>;
  getMemberByUsername(username: string): Promise<MemberRecord | null>;
  upsertMember(member: MemberRecord): Promise<void>;
  updateMemberCheck(
    telegramId: number,
    checkedAt: string,
    status: MemberStatus | null,
    revokedReason: string | null,
  ): Promise<void>;
  listMembersToReverify(checkedBefore: string, limit: number): Promise<MemberRecord[]>;
  countMembersByStatus(): Promise<Record<string, number>>;
  isTelegramDenied(telegramId: number): Promise<boolean>;

  // join requests
  addJoinRequest(telegramId: number, chatId: number, requestedAt: string): Promise<void>;
  listJoinRequestsForUser(telegramId: number): Promise<JoinRequestRecord[]>;
  deleteJoinRequest(telegramId: number, chatId: number): Promise<void>;
  listJoinRequests(limit: number): Promise<JoinRequestRecord[]>;
  listJoinRequestsBefore(requestedBefore: string, limit: number): Promise<JoinRequestRecord[]>;
  countJoinRequests(): Promise<number>;

  // overrides
  getOverride(login: string): Promise<OverrideRecord | null>;
  setOverride(o: Omit<OverrideRecord, "addedAt">, addedAt: string): Promise<void>;

  // audit
  audit(event: AuditEvent, entry: AuditEntry, at: string): Promise<void>;
  countAuditSince(event: AuditEvent, since: string): Promise<number>;
  purgeAudit(event: AuditEvent, before: string): Promise<number>;

  // LGPD
  deleteUserData(telegramId: number): Promise<void>;

  // oauth state
  saveOAuthState(stateHash: string, data: OAuthStateRecord): Promise<void>;
  peekOAuthState(stateHash: string, now: string): Promise<OAuthStateRecord | null>;
  /** Uso único: apaga e devolve numa operação atômica. */
  consumeOAuthState(stateHash: string, now: string): Promise<OAuthStateRecord | null>;
  purgeOAuthStates(now: string): Promise<number>;

  // seen members / chats / settings
  markSeen(telegramId: number, chatId: number, username: string | null, at: string): Promise<void>;
  /** Vistos nos chats que não têm verificação válida (sem registro ou revogados). */
  listUnverifiedSeen(limit: number): Promise<SeenMemberRecord[]>;
  deleteSeen(telegramId: number): Promise<void>;
  upsertChat(chatId: number, title: string | null, at: string): Promise<void>;
  getChatTitles(chatIds: number[]): Promise<Map<number, string>>;
  getSetting(key: string): Promise<string | null>;
  setSetting(key: string, value: string): Promise<void>;
}
