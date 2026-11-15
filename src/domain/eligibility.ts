/**
 * Regras de elegibilidade (seção 2 da spec). Tudo aqui é puro: sem I/O, sem relógio implícito.
 */

export interface IntraCursusUser {
  cursus_id: number;
  begin_at: string | null;
  end_date?: string | null;
  blackholed_at?: string | null;
  grade?: string | null;
}

export interface IntraCampusUser {
  campus_id: number;
  is_primary?: boolean;
}

export interface IntraUser {
  id: number;
  login: string;
  "alumni?"?: boolean;
  "active?"?: boolean;
  "staff?"?: boolean;
  cursus_users?: IntraCursusUser[];
  campus_users?: IntraCampusUser[];
}

export interface EligibilityConfig {
  allowedCampusIds: number[];
  allowStaff: boolean;
  mainCursusId: number;
}

export type AllowReason = "staff" | "alumni" | "cadete_ativo" | "override";

export type DenyReason =
  | "campus_nao_permitido"
  | "pisciner_ou_sem_cursus"
  | "cursus_nao_iniciado"
  | "blackhole"
  | "cursus_encerrado"
  | "conta_inativa"
  | "denylist"
  | "conta_compartilhada"
  | "conta_nao_encontrada";

export type EligibilityResult =
  { status: "PERMITIR"; motivo: AllowReason } | { status: "NEGAR"; motivo: DenyReason };

const permitir = (motivo: AllowReason): EligibilityResult => ({ status: "PERMITIR", motivo });
const negar = (motivo: DenyReason): EligibilityResult => ({ status: "NEGAR", motivo });

/** `true` se a data existe e já passou (ou é exatamente agora). Datas inválidas são ignoradas. */
function jaPassou(iso: string | null | undefined, agora: Date): boolean {
  if (!iso) return false;
  const t = Date.parse(iso);
  return !Number.isNaN(t) && t <= agora.getTime();
}

export function avaliarElegibilidade(
  user: IntraUser,
  agora: Date,
  config: EligibilityConfig,
): EligibilityResult {
  // 1. campus
  if (config.allowedCampusIds.length > 0) {
    const campi = user.campus_users ?? [];
    if (!campi.some((c) => config.allowedCampusIds.includes(c.campus_id))) {
      return negar("campus_nao_permitido");
    }
  }

  // 2. staff
  if (user["staff?"] === true && config.allowStaff) return permitir("staff");

  // 3. alumni
  if (user["alumni?"] === true) return permitir("alumni");

  // 4. 42cursus
  const cursus42 = (user.cursus_users ?? []).find((c) => c.cursus_id === config.mainCursusId);
  if (!cursus42) return negar("pisciner_ou_sem_cursus");

  // 5. cursus ainda não começou (sem begin_at também conta como não iniciado)
  if (!cursus42.begin_at || !jaPassou(cursus42.begin_at, agora)) {
    return negar("cursus_nao_iniciado");
  }

  // 6. blackhole
  if (jaPassou(cursus42.blackholed_at, agora)) return negar("blackhole");

  // 7. cursus encerrado ("e não é alumni" já está garantido: alumni retornou no passo 3)
  if (jaPassou(cursus42.end_date, agora)) return negar("cursus_encerrado");

  // 8. conta inativa
  if (user["active?"] === false) return negar("conta_inativa");

  // 9.
  return permitir("cadete_ativo");
}

export type OverrideType = "allow" | "deny";

/**
 * Aplica allowlist/denylist manual por cima do algoritmo.
 * Denylist vence tudo; allowlist libera mesmo quem o algoritmo negaria.
 */
export function decidirAcesso(
  user: IntraUser,
  override: OverrideType | null,
  agora: Date,
  config: EligibilityConfig,
): EligibilityResult {
  if (override === "deny") return negar("denylist");
  if (override === "allow") return permitir("override");
  return avaliarElegibilidade(user, agora, config);
}

export interface MemberValidity {
  lastCheckedAt: string;
  revokedReason: string | null;
}

/** Membro conta como verificado se não foi revogado e a última checagem tem menos de `reverifyDays`. */
export function membroVerificado(
  member: MemberValidity | null,
  denied: boolean,
  agora: Date,
  reverifyDays: number,
): boolean {
  if (!member || denied || member.revokedReason !== null) return false;
  const checked = Date.parse(member.lastCheckedAt);
  if (Number.isNaN(checked)) return false;
  return agora.getTime() - checked < reverifyDays * 86_400_000;
}
