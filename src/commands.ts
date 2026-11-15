/**
 * Listas de comandos, usadas pelo /help e pelo menu "/" do Telegram (scripts/set-webhook.ts).
 * Sem dependências de runtime para o script poder importar sem carregar o bot.
 */
export interface CommandInfo {
  command: string;
  description: string;
  /** Argumentos mostrados no /help, ex.: "<login> <motivo>". */
  usage?: string;
}

export const USER_COMMANDS: CommandInfo[] = [
  { command: "start", description: "Verificar pela Intra e entrar na comunidade" },
  { command: "status", description: "Ver se você está verificado" },
  { command: "grupos", description: "Os grupos da comunidade e do que cada um trata" },
  { command: "links", description: "Links úteis da comunidade" },
  { command: "privacidade", description: "Quais dados eu guardo e por quê" },
  { command: "apagar_dados", description: "Apagar seus dados e sair dos grupos" },
  { command: "ajuda", description: "Como falar com um admin" },
  { command: "help", description: "Lista de comandos" },
];

export const ADMIN_COMMANDS: CommandInfo[] = [
  { command: "help", description: "Esta lista de comandos" },
  { command: "stats", description: "Membros por status, pendentes e negados em 7 dias" },
  { command: "quem", description: "Situação de um membro", usage: "<@user | login>" },
  { command: "allow", description: "Libera um caso especial", usage: "<login> <motivo>" },
  { command: "deny", description: "Bloqueia e remove dos grupos", usage: "<login> <motivo>" },
  { command: "reverificar", description: "Revalida agora na Intra", usage: "<login>" },
  { command: "pendentes", description: "Pedidos de entrada esperando verificação" },
  {
    command: "sincronizar",
    description: "Confere permissões e atualiza nome e descrição dos grupos",
  },
  { command: "nao_verificados", description: "Quem foi visto nos grupos e não verificou" },
  { command: "avisar", description: "Fixa nos grupos o aviso para membros antigos verificarem" },
  { command: "chatid", description: "Mostra o ID do chat atual" },
];

/** No menu dos grupos protegidos aparece só o /help. */
export const GROUP_COMMANDS: CommandInfo[] = [
  { command: "help", description: "O que é o Flavinho e como usar" },
];

/** Formato aceito pelo setMyCommands (sem o campo `usage`). */
export const toBotCommands = (list: CommandInfo[]) =>
  list.map(({ command, description }) => ({ command, description }));
