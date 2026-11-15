# FlavinhoBot 🎟️

O porteiro da **42 Comunidade** no Telegram. Ninguém entra nos grupos sem provar, pelo login oficial da Intra 42, que é **cadete ativo** do 42cursus ou **alumni**. Pisciners, quem caiu no blackhole e gente de fora ficam "elegantes" do lado de fora.

- **Stack:** TypeScript 7 · grammY · Cloudflare Workers + D1 + Cron Triggers · zod · Vitest · Bun
- **Custo:** zero (plano free da Cloudflare)
- **Privacidade:** o bot nunca vê a senha, nunca salva token e guarda só `telegram_id`, @, login/ID da Intra, status, campus e datas.

---

## Como funciona

```
Usuário pede pra entrar (link com aprovação)  ──►  chat_join_request
   ├─ já verificado (< REVERIFY_DAYS)? → aprova direto
   ├─ denylist? → recusa
   └─ DM "Tá elegante hoje, hein, jovem? 👀" + botão [Entrar com a Intra 42]
          │
          ▼  /auth/start?state=…  →  api.intra.42.fr/oauth/authorize
          ▼  /auth/callback?code=…&state=…
      troca code → token → GET /v2/me → avaliarElegibilidade() → token descartado
          ├─ PERMITIDO → salva membro, DM de boas-vindas, aprova pendências
          └─ NEGADO    → DM com o motivo, recusa pendências
```

Porta alternativa: `t.me/FlavinhoBot?start=entrar` → `/start` → mesma verificação → botão **Convites para os grupos** gera um link de uso único (15 min) por chat protegido.

Verificação única: quem já verificou é aprovado direto em qualquer outro chat protegido.

### Estrutura

```
src/
├── index.ts               # entry do Worker: /webhook, /auth/start, /auth/callback, /health + cron
├── bot.ts                 # instância grammY e registro dos handlers
├── config.ts              # lê e valida o env com zod
├── messages.ts            # todos os textos (PT-BR, bordões do Flavinho)
├── handlers/              # joinRequest, commands.user, commands.admin, chatMember
├── auth/                  # oauth.ts (state), intraClient.ts (rate limit + retry)
├── domain/eligibility.ts  # avaliarElegibilidade() — função pura
├── db/                    # repository.ts (interface) + d1Repository.ts
├── services/              # orquestração do fluxo e chamadas idempotentes ao Telegram
├── http/                  # rotas do OAuth e páginas HTML
└── jobs/reverify.ts       # cron diário
migrations/                # SQL versionado (wrangler d1 migrations)
config/links.json          # links úteis da mensagem de boas-vindas
test/                      # Vitest: elegibilidade + fluxos completos com mocks
```

---

## Desenvolvimento

Requisitos: [Bun](https://bun.sh) ≥ 1.2 e Node ≥ 22.5 (os testes usam `node:sqlite` para rodar as migrations reais).

```bash
bun install
bun run test         # Vitest
bun run typecheck    # tsc (TypeScript 7)
bun run lint         # ESLint + Prettier
bun run dev          # wrangler dev em http://localhost:8787 (usa .dev.vars)
```

> **TypeScript 7 + ESLint:** o TS 7 ainda não tem API programática, então o `package.json` usa o arranjo oficial lado a lado: `@typescript/native` (TS 7, fornece o `tsc`) e `typescript` → `@typescript/typescript6` (API do TS 6 que o typescript-eslint precisa).

Para rodar local: `cp .env.example .dev.vars`, preencha, `bun run db:migrate:local` e `bun run dev`. Para simular o cron: `bunx wrangler dev --test-scheduled` e `curl "localhost:8787/__scheduled?cron=0+6+*+*+*"`.

---

## Deploy do zero (passo a passo)

### 1. Criar o bot no Telegram

Fale com o [@BotFather](https://t.me/BotFather):

1. `/newbot` → nome **FlavinhoBot** → username **@FlavinhoBot** (se estiver ocupado: `@Flavinho42Bot` ou `@Flavinho42SPBot`). Guarde o **token**.
2. `/setdescription` e `/setabouttext`, por exemplo: _"Porteiro da 42 Comunidade. Confirma pela Intra que você é cadete ou alumni e libera a entrada."_
3. `/setuserpic` com a foto da comunidade.
4. `/setcommands`: o `bun run set-webhook` (passo 8) já registra os comandos de usuário. Se preferir fazer à mão:
   ```
   start - Verificar pela Intra e entrar na comunidade
   status - Ver se você está verificado
   links - Links úteis da comunidade
   privacidade - Quais dados eu guardo e por quê
   apagar_dados - Apagar seus dados e sair dos grupos
   ajuda - Como falar com um admin
   ```
5. `/setprivacy` → **Enable**. Como o bot é admin nos grupos, ele recebe as mensagens mesmo assim, e é isso que permite registrar quem fala (passo 12).

### 2. Criar o app na Intra 42

Em <https://profile.intra.42.fr/oauth/applications/new>:

- **Redirect URI:** `https://flavinhobot.<sua-conta>.workers.dev/auth/callback` (o mesmo `PUBLIC_BASE_URL` + `/auth/callback`)
- **Scope:** `public`

Guarde o **UID** e o **SECRET**. ⚠️ Antes de divulgar, confirme com a equipe da 42 SP (bocal) se há regras para apps da comunidade.

### 3. Cloudflare

Crie uma conta grátis em <https://dash.cloudflare.com> e faça login no wrangler (já vem nas devDependencies):

```bash
bunx wrangler login
```

### 4. Criar o banco

```bash
bunx wrangler d1 create flavinhobot
```

Cole o `database_id` em `wrangler.toml`.

> **Sobre o KV:** a spec permitia "KV ou tabela D1 com TTL" para o `state` do OAuth. Usei uma **tabela D1** (`oauth_states`): o `DELETE … RETURNING` consome o state de forma atômica (uso único garantido, já que o KV é eventualmente consistente) e não gasta a cota de escrita do KV (1000/dia no free). Então **não é preciso criar namespace KV**.

### 5. Aplicar as migrations

```bash
bun run db:migrate:remote
```

### 6. Secrets

```bash
bunx wrangler secret put TELEGRAM_BOT_TOKEN
bunx wrangler secret put TELEGRAM_WEBHOOK_SECRET   # gere com: openssl rand -hex 32
bunx wrangler secret put INTRA_CLIENT_ID
bunx wrangler secret put INTRA_CLIENT_SECRET
```

Edite as `[vars]` do `wrangler.toml` (`PUBLIC_BASE_URL`, `ADMIN_CHAT_ID`, `ADMIN_IDS`…). Nesse primeiro deploy, `PROTECTED_CHAT_IDS` pode ficar vazio.

### 7. Deploy

```bash
bun run deploy
curl https://flavinhobot.<sua-conta>.workers.dev/health
```

### 8. Registrar o webhook

Crie um `.env` (a partir do `.env.example`) com `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET` e `PUBLIC_BASE_URL`, e rode:

```bash
bun run set-webhook
```

O script chama `setWebhook` com `secret_token` e `allowed_updates = ["message","chat_join_request","chat_member","my_chat_member","callback_query"]`, depois registra os comandos. O `my_chat_member` foi incluído porque é ele que avisa quando o bot é adicionado a um chat novo.

### 9. Configurar cada chat da 42 Comunidade

Em **cada** chat existente:

1. Deixe o grupo **privado**.
2. Adicione o bot como **admin** com: _Convidar usuários_ (`can_invite_users`), _Banir usuários_ (`can_restrict_members`), _Apagar mensagens_ (`can_delete_messages`) e, de preferência, _Fixar mensagens_ (usado pelo `/avisar`).
3. **Revogue** todos os links antigos de entrada direta.
4. Crie o link de convite com **"Pedir aprovação de admin"** ligado.
5. Deixe o canal/tópico **Announcements** só para admins.

### 10. Descobrir os `chat_id`

Ao virar admin, o bot avisa no `ADMIN_CHAT_ID`: _"Fui adicionado ao chat X (id Y). Incluir em PROTECTED_CHAT_IDS?"_. Também dá pra mandar `/chatid` em qualquer chat (só admins). Coloque os IDs em `PROTECTED_CHAT_IDS` (separados por vírgula) e rode `bun run deploy` de novo. Adicionar um chat novo depois é só isso: incluir o ID e tornar o bot admin, sem mexer no código.

### 11. Conferir permissões

No privado com o bot (ou no chat de admins): `/sincronizar`. Ele lista cada chat protegido com ✅, ⚠️ (falta permissão / grupo público) ou ❌ (bot não é admin).

### 12. Membros que já estavam nos chats

A Bot API não lista os membros de um grupo, então o bot registra quem **fala** ou **entra** nos chats protegidos (tabela `seen_members`).

1. Mande `/avisar`: o bot posta e fixa em todos os chats _"Jovens, tem gente elegante por aqui 👀 …faz /start comigo no privado até {data}"_. O prazo é `GRANDFATHER_DAYS` (padrão 14).
2. `/nao_verificados` mostra quem foi visto e ainda não verificou.
3. Depois do prazo, o cron diário manda a lista para os admins ou, com `AUTO_REMOVE=true`, remove essas pessoas (sem banir) e manda uma DM gentil.

Quem nunca fala nem entra depois do bot não aparece na lista. Essa é uma limitação do Telegram.

### 13. CI/CD

`.github/workflows/ci.yml` roda typecheck, lint e testes em todo PR. Em push na `main`, aplica as migrations e faz `wrangler deploy`. Configure o secret do repositório **`CLOUDFLARE_API_TOKEN`** com um token que tenha permissões _Workers Scripts: Edit_ e _D1: Edit_.

---

## Migração do WhatsApp

1. Fixe no Announcements do WhatsApp: `t.me/FlavinhoBot?start=entrar` + _"a entrada é validada pela Intra, leva 30 segundos"_.
2. Deixe os dois ativos por 2 a 4 semanas.
3. Admins e staff entram primeiro para testar o fluxo.
4. Acompanhe `/stats` e `/pendentes` e use `/allow` para destravar casos especiais.

---

## Comandos

**Usuário (privado):** `/start` · `/status` · `/links` · `/privacidade` · `/apagar_dados` · `/ajuda`

**Admin** (`ADMIN_IDS`, só no privado ou no `ADMIN_CHAT_ID`; não-admins não recebem resposta):

| Comando                                 | Ação                                                                     |
| --------------------------------------- | ------------------------------------------------------------------------ |
| `/stats`                                | membros por status, pendentes, negados em 7 dias, vistos sem verificação |
| `/quem <@user \| login \| telegram_id>` | status de um membro                                                      |
| `/allow <login> <motivo>`               | allowlist (a pessoa ainda faz login na Intra para provar identidade)     |
| `/deny <login> <motivo>`                | denylist + remove dos grupos + recusa pedidos                            |
| `/reverificar <login>`                  | revalida agora na Intra                                                  |
| `/pendentes`                            | join requests pendentes                                                  |
| `/sincronizar`                          | confere admin/permissões em todos os chats protegidos                    |
| `/nao_verificados`                      | vistos nos chats sem verificação                                         |
| `/avisar`                               | posta e fixa o aviso para membros antigos e define o prazo               |
| `/chatid`                               | mostra o ID do chat (setup; funciona em qualquer chat para admins)       |

---

## Configuração (env)

| Nome                                      | Tipo   | Padrão                    | Descrição                                              |
| ----------------------------------------- | ------ | ------------------------- | ------------------------------------------------------ |
| `TELEGRAM_BOT_TOKEN`                      | secret | —                         | token do @BotFather                                    |
| `TELEGRAM_WEBHOOK_SECRET`                 | secret | —                         | 16–256 chars `[A-Za-z0-9_-]`, validado em todo webhook |
| `INTRA_CLIENT_ID` / `INTRA_CLIENT_SECRET` | secret | —                         | app da 42                                              |
| `PUBLIC_BASE_URL`                         | var    | —                         | URL do Worker (https)                                  |
| `PROTECTED_CHAT_IDS`                      | var    | vazio                     | chats protegidos                                       |
| `ADMIN_CHAT_ID`                           | var    | —                         | chat de alertas                                        |
| `ADMIN_IDS`                               | var    | —                         | telegram_ids dos admins                                |
| `ALLOWED_CAMPUS_IDS`                      | var    | vazio                     | `20` = 42 São Paulo; vazio = qualquer campus           |
| `ALLOW_STAFF`                             | var    | `false`                   | libera `staff?`                                        |
| `REVERIFY_DAYS`                           | var    | `30`                      | validade da verificação                                |
| `AUTO_REMOVE`                             | var    | `false`                   | remover automaticamente quem perdeu acesso             |
| `JOIN_REQUEST_TIMEOUT_HOURS`              | var    | `24`                      | pedido pendente expira                                 |
| `GRANDFATHER_DAYS`                        | var    | `14`                      | prazo dos membros antigos                              |
| `INTRA_MAIN_CURSUS_ID`                    | var    | `21`                      | ID do 42cursus                                         |
| `REVERIFY_MAX_PER_RUN`                    | var    | `30`                      | teto de revalidações por execução do cron              |
| `INTRA_API_BASE_URL`                      | var    | `https://api.intra.42.fr` | —                                                      |

Se faltar ou estiver inválido algo, o Worker responde 500 e loga exatamente qual variável está errada.

Os links da mensagem de boas-vindas ficam em `config/links.json`. **Troque os placeholders do Guia de Sobrevivência (Notion) e do Plano de Estudos (planilha) pelas URLs reais.**

---

## Itens [VALIDAR] da spec

Tudo que a spec marcou para validar ficou **configurável**. Confira antes de ir para produção:

| Item                                        | Valor adotado                                                                                                                                                                                                 | Como confirmar                          |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| `cursus_id` do 42cursus                     | `21` (`INTRA_MAIN_CURSUS_ID`)                                                                                                                                                                                 | `GET /v2/cursus/42cursus`               |
| `cursus_id` da C Piscine                    | `9` (só documental: quem não tem o 42cursus é negado)                                                                                                                                                         | `GET /v2/cursus/c-piscine`              |
| `campus_id` da 42 São Paulo                 | `20` (`ALLOWED_CAMPUS_IDS`)                                                                                                                                                                                   | `GET /v2/campus?filter[name]=São Paulo` |
| Rate limit da API da 42                     | 2 req/s e 1200 req/h: o cliente espaça 600 ms entre chamadas, faz retry com backoff em 429/5xx (respeitando `Retry-After`)                                                                                    | página do seu app na Intra              |
| PKCE na Intra                               | **não usado** (opcional na spec, sem confirmação de suporte). O `state` de uso único + `redirect_uri` fixo + client secret no servidor cobrem o fluxo                                                         | testar `code_challenge` no authorize    |
| Convite para a "comunidade" inteira via bot | **não suportado**: a Bot API só cria convites por chat (`createChatInviteLink`), então o bot entrega um link de uso único por chat protegido                                                                  | —                                       |
| DM após join request                        | o Telegram deixa o bot mandar DM por até 5 min após o pedido, **até ele ser processado**. Por isso o bot manda a DM **antes** de aprovar/recusar, e a página do callback também mostra o resultado e os links | —                                       |

### Limites do plano free (e como o código respeita)

- **50 subrequests por invocação:** o cron trabalha com um orçamento (`Budget`, 45 por padrão): expira pedidos, revalida membros e só remove se couber. O que sobrar fica para o dia seguinte (o mais antigo primeiro). Com 400 membros e `REVERIFY_DAYS=30`, são cerca de 14 por dia; o teto é 30.
- **Convites:** são até 1 chamada por chat (≈19 chats), feitas num update separado (botão), longe do limite.
- **Webhook:** responde em milissegundos; o processamento roda em `ctx.waitUntil()`.
- **Remoção sem banir:** `unbanChatMember` sem `only_if_banned` remove quem está no grupo e deixa voltar, com 1 chamada por chat em vez de 2 (ban + unban).

---

## Segurança e LGPD

- `state`: 32 bytes aleatórios (`crypto.getRandomValues`), TTL de 10 min, uso único (consumo atômico), e no banco fica só o **SHA-256**.
- O link no Telegram aponta para o próprio Worker (`/auth/start?state=…`), que só então redireciona para a Intra.
- Token do usuário: usado uma vez para `GET /v2/me` e descartado. Nunca vai para o banco nem para os logs (há teste garantindo isso).
- `intra_id` é `UNIQUE`: uma Intra libera um Telegram só. Uma segunda tentativa é negada e os admins são avisados.
- Webhook: `X-Telegram-Bot-Api-Secret-Token` comparado em tempo constante, e qualquer coisa diferente recebe 401.
- Rate limit por `telegram_id` nos comandos e por IP/`telegram_id` em `/auth/*` (em memória, por isolate).
- Logs em JSON sem PII: `telegram_id` vira um hash curto e tokens do bot são mascarados nas mensagens de erro.
- Erros inesperados vão para o `ADMIN_CHAT_ID`, com no máximo 1 aviso a cada 10 min por origem.
- `/apagar_dados` remove a pessoa dos grupos e apaga membro, pedidos, registros de "visto" e audit_log dela. Registros de negação somem do audit_log em 90 dias (cron).
- Uma entrada na denylist (por login da Intra) **sobrevive** ao `/apagar_dados`, para que ninguém burle um bloqueio apagando os dados.

---

## Testes

`test/eligibility.test.ts` cobre todos os ramos de `avaliarElegibilidade()`, com fixtures de cadete ativo, alumni, pisciner, blackhole, cursus futuro, outro campus, staff, conta inativa e cursus encerrado, além da allowlist/denylist e da validade da verificação.

`test/flows.test.ts` roda os fluxos ponta a ponta com o **D1Repository real** (migrations aplicadas em SQLite) e mocks da Bot API e da Intra. Ele cobre os critérios de aceite: webhook 401, cadete entra, pisciner/blackhole recusados, uma Intra ↔ um Telegram, state reutilizado/expirado, idempotência (`HIDE_REQUESTER_MISSING`), denylist, convites de uso único, `/apagar_dados`, admin vs. não-admin, cron (revogação, `AUTO_REMOVE`, orçamento de subrequests, retry em 429, expiração de pedidos e retenção de 90 dias) e ausência de tokens no banco e nos logs.
