/**
 * Todos os textos do FlavinhoBot. Mensagens do Telegram usam parse_mode HTML.
 * Regra do bordão: "elegante" só aparece quando falta acesso — nunca em mensagens de sucesso.
 */
import type { DenyReason } from "./domain/eligibility";

export const escapeHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const dataBr = (d: Date): string =>
  d.toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" });

export const msg = {
  // ---------- entrada / verificação ----------
  pedidoVerificacao:
    "Tá elegante hoje, hein, jovem? 👀 Cadê o cordão? Aqui o cordão é a Intra: confirma que você é " +
    "cadete ou alumni da 42 e eu libero a entrada. Leva 30 segundos.\n\n" +
    "🔒 <b>Privacidade:</b> eu só guardo seu ID e @ do Telegram, seu login e ID da Intra, seu status " +
    "(cadete/alumni), campus e as datas da verificação — só pra controlar o acesso à comunidade. " +
    "Nada de senha, e-mail ou notas. Ao clicar no botão você concorda com isso (/privacidade).\n\n" +
    "O link vale por 10 minutos.",
  botaoEntrar: "🔑 Entrar com a Intra 42",

  aprovado: (login: string) =>
    `Agora sim, jovem <b>${escapeHtml(login)}</b>! ✅ Cordão no pescoço, pode entrar na 42 Comunidade. ` +
    "Dá uma olhada nos links úteis 👇",
  botaoConvites: "🎟️ Convites para os grupos",
  jaVerificado: "Opa, jovem, já te conheço! Pode passar 😄",
  jaVerificadoStart:
    "Opa, jovem, já te conheço! 😄 Toca no botão aí embaixo que eu gero seus convites para os grupos.",
  convites: (minutos: number) =>
    `Bora, jovem! Aqui estão seus convites 🎟️ Cada link é só seu, vale uma entrada e expira em ${minutos} minutos.`,
  semChatsProtegidos: "Ainda não tem nenhum grupo configurado, jovem. Fala com um admin: /ajuda",
  conviteFalhou: (n: number) =>
    `⚠️ Não consegui gerar ${n} convite(s). Os admins já foram avisados.`,
  precisaVerificarAntes:
    "Tá elegante, jovem 👀 Primeiro pega o cordão: manda /start pra verificar pela Intra.",

  linkExpirado: "Esse link venceu, jovem. Elegante assim não dá 😅 Manda /start que eu gero outro.",
  pedidoExpirado:
    "Seu pedido pra entrar ficou parado tempo demais e eu precisei recusar, jovem. " +
    "Sem estresse: é só pedir pra entrar de novo ou mandar /start aqui 😉",

  negado: (motivo: DenyReason): string => {
    switch (motivo) {
      case "pisciner_ou_sem_cursus":
        return (
          "Calma, jovem! Parece que você ainda está na Piscine. A comunidade é para cadetes e alumni, " +
          "então por enquanto você vai ter que continuar elegante 😅 Boa sorte na Piscine! 🏊 " +
          "Quando virar cadete, volta aqui que eu te dou o cordão."
        );
      case "cursus_nao_iniciado":
        return (
          "Quase lá, jovem! Seu 42cursus ainda não começou, então por enquanto segue elegante 😅 " +
          "Assim que começar, manda /start que eu te dou o cordão."
        );
      case "campus_nao_permitido":
        return (
          "Opa, jovem, tá elegante por aqui 👀 Essa comunidade é da 42 São Paulo e não achei esse " +
          "campus na sua conta. Se achar que é engano, fala com um admin: /ajuda"
        );
      case "blackhole":
      case "cursus_encerrado":
      case "conta_inativa":
      case "conta_nao_encontrada":
        return (
          "Ih, jovem, tá elegante… não consegui confirmar um cursus ativo na sua conta. " +
          "Se achar que é engano, fala com um admin: /ajuda"
        );
      case "conta_compartilhada":
        return (
          "Tá elegante, jovem 👀 Essa conta da Intra já está ligada a outro Telegram. " +
          "Cada login vale um cordão só. Se isso for engano, fala com um admin: /ajuda"
        );
      case "denylist":
        return "Desculpa, jovem, não consigo liberar sua entrada. Se quiser conversar, fala com um admin: /ajuda";
    }
  },
  revisao: "Se quiser pedir uma revisão, fala com um admin: /ajuda",

  // ---------- comandos de usuário ----------
  start:
    "Fala, jovem! 👋 Eu sou o <b>Flavinho</b>, o porteiro da 42 Comunidade. " +
    "Aqui só entra cadete ou alumni da 42, e quem confirma isso é a Intra.",
  statusVerificado: (login: string, status: string, ate: Date) =>
    `Tudo certo, jovem! ✅ Você está verificado como <b>${escapeHtml(login)}</b> (${escapeHtml(status)}).\n` +
    `Próxima checagem automática até ${dataBr(ate)}.`,
  statusVencido: (login: string) =>
    `Jovem <b>${escapeHtml(login)}</b>, sua verificação precisa ser renovada. Manda /start 😉`,
  statusRevogado:
    "Tá elegante, jovem 👀 Na última checagem não consegui confirmar seu acesso. " +
    "Manda /start pra verificar de novo ou fala com um admin: /ajuda",
  statusNaoVerificado:
    "Você ainda não pegou o cordão, jovem 👀 Manda /start pra verificar pela Intra.",
  links: "Links úteis da comunidade 👇",
  privacidade:
    "🔒 <b>Privacidade (LGPD)</b>\n\n" +
    "<b>O que eu guardo:</b> seu ID e @ do Telegram, seu login e ID da Intra, seu status " +
    "(cadete, alumni, staff ou liberação manual), seu campus e as datas de verificação e consentimento.\n\n" +
    "<b>Pra quê:</b> só pra controlar o acesso aos grupos da 42 Comunidade e revalidar o acesso " +
    "de tempos em tempos.\n\n" +
    "<b>O que eu NÃO guardo:</b> senha (eu nunca vejo), tokens, e-mail, nome, foto, telefone ou notas.\n\n" +
    "Registros de verificações negadas são apagados em até 90 dias.\n" +
    "Quer apagar tudo? Manda /apagar_dados.",
  apagarConfirmar:
    "Tem certeza, jovem? Isso apaga seus dados e te remove de todos os grupos da comunidade. " +
    "Pra voltar depois, é só verificar de novo.",
  botaoApagarSim: "Sim, apagar tudo",
  botaoApagarNao: "Cancelar",
  apagado: "Pronto, jovem. Seus dados foram apagados e você saiu dos grupos. Até mais! 👋",
  apagarCancelado: "Beleza, jovem, não apaguei nada 😉",
  ajuda:
    "Precisa de ajuda, jovem? Fala com um dos admins da comunidade no privado ou manda mensagem " +
    "no grupo Geral. Se for problema com a verificação, conta seu login da Intra que a gente resolve.",
  rateLimited: "Calma, jovem, uma coisa de cada vez 😅 Tenta de novo em um minutinho.",
  apenasPrivado: "Esse comando é só no privado, jovem 😉",

  // ---------- avisos nos chats ----------
  avisoGrandfather: (prazo: Date, botUsername: string) =>
    `Jovens, tem gente elegante por aqui 👀 Quem entrou antes de mim, faz /start comigo no privado ` +
    `(@${escapeHtml(botUsername)}) até ${dataBr(prazo)} para pegar o cordão.`,

  // ---------- DM de remoção ----------
  removido:
    "Oi, jovem. Na revalidação periódica não consegui mais confirmar seu acesso pela Intra, então " +
    "precisei te tirar dos grupos da 42 Comunidade. Se achar que é engano, manda /start ou /ajuda 💙",
  removidoNaoVerificado:
    "Oi, jovem. O prazo pra verificar pela Intra acabou e precisei te tirar dos grupos da 42 Comunidade. " +
    "Sem ressentimentos: manda /start aqui que eu te devolvo o cordão 💙",

  // ---------- páginas HTML (callback do OAuth) ----------
  paginaSucessoTitulo: "Tudo certo, jovem! ✅",
  paginaSucesso: "Verificação concluída. Pode voltar ao Telegram.",
  paginaNegadaTitulo: "Não deu dessa vez",
  paginaNegada: "Mandei os detalhes no Telegram. Pode voltar pra lá.",
  paginaExpiradaTitulo: "Link vencido",
  paginaErroTitulo: "Ops!",
  paginaErro: "Algo deu errado do nosso lado. Tenta de novo pelo Telegram com /start.",
  paginaCancelada: "Login cancelado. Quando quiser, é só mandar /start no Telegram.",
  paginaRateLimited: "Muitas tentativas seguidas. Espera um minutinho e tenta de novo.",
} as const;

/** Texto curto para logs/admins (sem PII). */
export const motivoAdmin: Record<DenyReason, string> = {
  campus_nao_permitido: "campus não permitido",
  pisciner_ou_sem_cursus: "pisciner / sem 42cursus",
  cursus_nao_iniciado: "42cursus não iniciado",
  blackhole: "blackhole",
  cursus_encerrado: "cursus encerrado",
  conta_inativa: "conta inativa",
  denylist: "denylist",
  conta_compartilhada: "Intra já ligada a outro Telegram",
  conta_nao_encontrada: "conta não encontrada na Intra",
};
