import { describe, expect, it } from "vitest";
import {
  avaliarElegibilidade,
  decidirAcesso,
  membroVerificado,
  type EligibilityConfig,
  type IntraUser,
} from "../src/domain/eligibility";
import alumni from "./fixtures/alumni.json";
import blackhole from "./fixtures/blackhole.json";
import cadete from "./fixtures/cadete.json";
import cursusFuturo from "./fixtures/cursus-futuro.json";
import encerrado from "./fixtures/encerrado.json";
import inativo from "./fixtures/inativo.json";
import outroCampus from "./fixtures/outro-campus.json";
import pisciner from "./fixtures/pisciner.json";
import staff from "./fixtures/staff.json";

const AGORA = new Date("2026-11-15T12:00:00.000Z");
const config: EligibilityConfig = { allowedCampusIds: [20], allowStaff: true, mainCursusId: 21 };

const u = (fixture: unknown): IntraUser => structuredClone(fixture) as IntraUser;

describe("avaliarElegibilidade", () => {
  it("1. nega campus não permitido", () => {
    expect(avaliarElegibilidade(u(outroCampus), AGORA, config)).toEqual({
      status: "NEGAR",
      motivo: "campus_nao_permitido",
    });
  });

  it("1. sem campus_users também é negado quando há campus configurado", () => {
    const user = u(cadete);
    delete user.campus_users;
    expect(avaliarElegibilidade(user, AGORA, config).motivo).toBe("campus_nao_permitido");
  });

  it("1. lista de campus vazia aceita qualquer campus", () => {
    expect(
      avaliarElegibilidade(u(outroCampus), AGORA, { ...config, allowedCampusIds: [] }),
    ).toEqual({ status: "PERMITIR", motivo: "cadete_ativo" });
  });

  it("2. permite staff quando ALLOW_STAFF=true", () => {
    expect(avaliarElegibilidade(u(staff), AGORA, config)).toEqual({
      status: "PERMITIR",
      motivo: "staff",
    });
  });

  it("2. staff sem cursus é negado quando ALLOW_STAFF=false", () => {
    expect(avaliarElegibilidade(u(staff), AGORA, { ...config, allowStaff: false })).toEqual({
      status: "NEGAR",
      motivo: "pisciner_ou_sem_cursus",
    });
  });

  it("3. permite alumni mesmo com conta inativa e blackhole antigo", () => {
    expect(avaliarElegibilidade(u(alumni), AGORA, config)).toEqual({
      status: "PERMITIR",
      motivo: "alumni",
    });
  });

  it("4. nega pisciner (só cursus 9)", () => {
    expect(avaliarElegibilidade(u(pisciner), AGORA, config)).toEqual({
      status: "NEGAR",
      motivo: "pisciner_ou_sem_cursus",
    });
  });

  it("4. nega conta sem cursus algum", () => {
    const user = u(cadete);
    user.cursus_users = [];
    expect(avaliarElegibilidade(user, AGORA, config).motivo).toBe("pisciner_ou_sem_cursus");
  });

  it("5. nega cursus que ainda não começou", () => {
    expect(avaliarElegibilidade(u(cursusFuturo), AGORA, config)).toEqual({
      status: "NEGAR",
      motivo: "cursus_nao_iniciado",
    });
  });

  it("5. nega cursus sem begin_at", () => {
    const user = u(cadete);
    user.cursus_users![1]!.begin_at = null;
    expect(avaliarElegibilidade(user, AGORA, config).motivo).toBe("cursus_nao_iniciado");
  });

  it("6. nega blackhole vencido", () => {
    expect(avaliarElegibilidade(u(blackhole), AGORA, config)).toEqual({
      status: "NEGAR",
      motivo: "blackhole",
    });
  });

  it("6. blackhole exatamente agora conta como vencido", () => {
    const user = u(cadete);
    user.cursus_users![1]!.blackholed_at = AGORA.toISOString();
    expect(avaliarElegibilidade(user, AGORA, config).motivo).toBe("blackhole");
  });

  it("7. nega cursus encerrado sem alumni", () => {
    expect(avaliarElegibilidade(u(encerrado), AGORA, config)).toEqual({
      status: "NEGAR",
      motivo: "cursus_encerrado",
    });
  });

  it("8. nega conta inativa", () => {
    expect(avaliarElegibilidade(u(inativo), AGORA, config)).toEqual({
      status: "NEGAR",
      motivo: "conta_inativa",
    });
  });

  it("9. permite cadete ativo", () => {
    expect(avaliarElegibilidade(u(cadete), AGORA, config)).toEqual({
      status: "PERMITIR",
      motivo: "cadete_ativo",
    });
  });

  it("9. cadete com blackhole no futuro e end_date futuro é permitido", () => {
    const user = u(cadete);
    user.cursus_users![1]!.end_date = "2030-01-01T00:00:00.000Z";
    expect(avaliarElegibilidade(user, AGORA, config).status).toBe("PERMITIR");
  });

  it("respeita mainCursusId configurável", () => {
    expect(avaliarElegibilidade(u(pisciner), AGORA, { ...config, mainCursusId: 9 }).status).toBe(
      "PERMITIR",
    );
  });
});

describe("decidirAcesso", () => {
  it("denylist vence elegibilidade", () => {
    expect(decidirAcesso(u(cadete), "deny", AGORA, config)).toEqual({
      status: "NEGAR",
      motivo: "denylist",
    });
  });

  it("allowlist libera quem seria negado", () => {
    expect(decidirAcesso(u(pisciner), "allow", AGORA, config)).toEqual({
      status: "PERMITIR",
      motivo: "override",
    });
  });

  it("sem override usa o algoritmo", () => {
    expect(decidirAcesso(u(blackhole), null, AGORA, config).motivo).toBe("blackhole");
  });
});

describe("membroVerificado", () => {
  const recente = { lastCheckedAt: "2026-11-01T00:00:00.000Z", revokedReason: null };

  it("verificado dentro do prazo", () => {
    expect(membroVerificado(recente, false, AGORA, 30)).toBe(true);
  });
  it("vencido após REVERIFY_DAYS", () => {
    expect(membroVerificado(recente, false, AGORA, 10)).toBe(false);
  });
  it("revogado não conta", () => {
    expect(membroVerificado({ ...recente, revokedReason: "blackhole" }, false, AGORA, 30)).toBe(
      false,
    );
  });
  it("negado na denylist não conta", () => {
    expect(membroVerificado(recente, true, AGORA, 30)).toBe(false);
  });
  it("sem registro não conta", () => {
    expect(membroVerificado(null, false, AGORA, 30)).toBe(false);
  });
});
