# Arquitetura

Como o FlavinhoBot está organizado, por que ele foi feito assim e onde mexer para mudar cada coisa.

## Visão geral

Tudo roda num único Cloudflare Worker com quatro rotas HTTP e um cron:

| Entrada              | O que faz                                                                                         |
| -------------------- | ------------------------------------------------------------------------------------------------- |
| `POST /webhook`      | recebe updates do Telegram. Valida o secret, responde 200 na hora e processa em `ctx.waitUntil()` |
| `GET /auth/start`    | valida o `state` e redireciona para a Intra                                                       |
| `GET /auth/callback` | consome o `state`, troca o code, avalia a elegibilidade e mostra uma página de resultado          |
| `GET /health`        | status simples para monitoramento                                                                 |
| Cron `0 6 * * *`     | expira pedidos, revalida membros, cobra não verificados e limpa dados antigos                     |

O banco é o Cloudflare D1 (SQLite). Não há outro serviço de estado.

## Estrutura do código

```
src/
├── index.ts               entry do Worker: roteamento HTTP e handler do cron
├── bot.ts                 cria a instância grammY e registra os handlers
├── config.ts              lê e valida o env com zod
├── messages.ts            todos os textos do bot, em PT-BR
├── logger.ts              logs JSON sem PII
├── rateLimit.ts           rate limit em memória por chave
├── domain/
│   └── eligibility.ts     avaliarElegibilidade(), decidirAcesso(), membroVerificado(): funções puras
├── auth/
│   ├── oauth.ts           geração, hash e criação do state
│   └── intraClient.ts     cliente da API da 42 com espaçamento entre chamadas e retry
├── db/
│   ├── repository.ts      interface Repository
│   └── d1Repository.ts    implementação para D1
├── services/
│   ├── context.ts         tipo Services (dependências injetáveis)
│   ├── access.ts          fluxo de verificação, aprovação e convites
│   └── telegram.ts        chamadas idempotentes ao Telegram, alertas aos admins
├── handlers/
│   ├── joinRequest.ts     chat_join_request
│   ├── commands.user.ts   comandos e botões no privado
│   ├── commands.admin.ts  comandos de admin
│   └── chatMember.ts      my_chat_member, chat_member e registro de quem fala
├── http/
│   ├── authRoutes.ts      /auth/start e /auth/callback
│   └── html.ts            páginas HTML sem JS
└── jobs/
    └── reverify.ts        cron diário
```

Handlers, rotas e jobs recebem um objeto `Services` (config, repositório, cliente da Intra, API do Telegram e relógio). Nos testes, cada peça é trocada por um mock ou por uma implementação em memória.

## Elegibilidade

O algoritmo da spec está em [`src/domain/eligibility.ts`](../src/domain/eligibility.ts), sem I/O e com o horário recebido como parâmetro. A ordem dos passos importa:

1. Campus fora de `ALLOWED_CAMPUS_IDS` → nega (`campus_nao_permitido`)
2. Staff com `ALLOW_STAFF=true` → libera (`staff`)
3. Alumni → libera (`alumni`)
4. Sem o 42cursus (`cursus_id` 21) → nega (`pisciner_ou_sem_cursus`)
5. 42cursus ainda não começou → nega (`cursus_nao_iniciado`)
6. Blackhole vencido → nega (`blackhole`)
7. Cursus encerrado → nega (`cursus_encerrado`)
8. Conta inativa → nega (`conta_inativa`)
9. Caso contrário → libera (`cadete_ativo`)

Por cima disso, `decidirAcesso()` aplica a tabela `overrides`: `deny` vence tudo e `allow` libera mesmo quem o algoritmo negaria. Fora da função pura, o fluxo ainda nega quando a conta da Intra já está ligada a outro Telegram (`conta_compartilhada`).

Cada motivo de negação vira uma mensagem amigável em `messages.ts` e um texto curto para os admins em `motivoAdmin`.

## Fluxos

### Pedido de entrada

1. O Telegram manda `chat_join_request`. Chats fora de `PROTECTED_CHAT_IDS` são ignorados.
2. Se o usuário está na denylist, o pedido é recusado.
3. Se já está verificado (não revogado e checado há menos de `REVERIFY_DAYS`), o bot manda "já te conheço" e aprova.
4. Senão, o pedido vai para `join_requests`, o bot cria um `state` e manda a DM com o botão de login.

### Callback da Intra

1. O `state` é consumido de forma atômica. Reutilizado, expirado ou malformado: página de link vencido.
2. O code é trocado por um token, o bot lê `GET /v2/me` e o token é descartado.
3. `decidirAcesso()` decide. Se liberado, o bot confere se aquela Intra já pertence a outro Telegram.
4. O resultado vai para o banco (`members` e `audit_log`) e a página de resposta é montada.
5. Em `waitUntil`, o bot manda a DM e então aprova ou recusa todos os pedidos pendentes daquele usuário.

A DM vai **antes** da aprovação porque o Telegram só permite falar com quem pediu para entrar enquanto o pedido não foi processado (e por até 5 minutos). Se a DM falhar, a página do callback já mostrou o resultado e os links.

### /start no privado

Quem não está verificado recebe a mesma DM de login. Quem está verificado tem os pedidos pendentes aprovados e recebe convites de uso único: `createChatInviteLink` com `member_limit = 1` e `expire_date` em 15 minutos, um por grupo protegido.

### Cron diário

Na ordem:

1. Apaga `state`s expirados e registros de negação com mais de 90 dias.
2. Recusa pedidos parados há mais de `JOIN_REQUEST_TIMEOUT_HOURS` e avisa o usuário.
3. Revalida os membros com checagem mais antiga que `REVERIFY_DAYS`, começando pelos mais antigos, usando token de app (`client_credentials`) e `GET /v2/users/:id`.
4. Depois do prazo do `/avisar`, lista ou remove quem foi visto nos grupos sem verificar.
5. Manda um resumo para os admins, se algo relevante aconteceu.

Quem deixa de ser elegível recebe `revoked_reason` e para de ser aprovado direto. Com `AUTO_REMOVE=true`, também é removido dos grupos.

## Modelo de dados

As migrations ficam em [`migrations/`](../migrations) e são aplicadas com `wrangler d1 migrations apply`.

| Tabela          | Conteúdo                                                                                                  |
| --------------- | --------------------------------------------------------------------------------------------------------- |
| `members`       | um registro por Telegram verificado. `intra_id` é `UNIQUE`. `revoked_reason` nulo significa acesso válido |
| `join_requests` | pedidos de entrada esperando verificação                                                                  |
| `overrides`     | allowlist e denylist por login da Intra                                                                   |
| `audit_log`     | eventos (`verified`, `denied`, `approved`, `removed`...) sem dados sensíveis                              |
| `oauth_states`  | hash SHA-256 do `state`, dono e expiração                                                                 |
| `seen_members`  | quem falou ou entrou nos grupos protegidos                                                                |
| `chats`         | título dos grupos, para nomear os botões de convite                                                       |
| `settings`      | configurações de runtime, como o prazo do `/avisar`                                                       |

A `0001_init.sql` é o esquema da spec. A `0002_operational.sql` adiciona o que os fluxos precisaram.

Para trocar de banco (Postgres no Supabase ou Neon, por exemplo), implemente a interface [`Repository`](../src/db/repository.ts). Nada fora de `src/db/` fala SQL.

## Segurança

- **State do OAuth:** 32 bytes de `crypto.getRandomValues`, TTL de 10 minutos e uso único (`DELETE ... RETURNING`). No banco fica só o SHA-256.
- **Link de login:** aponta para o próprio Worker (`/auth/start?state=...`), que só então redireciona para a Intra. O `redirect_uri` é fixo.
- **Token do usuário:** fica só em memória, durante o callback. Os testes conferem que ele não aparece no banco nem nos logs.
- **Uma Intra, um Telegram:** a constraint `UNIQUE` em `intra_id` impede o vínculo duplo. Uma segunda tentativa é negada e os admins recebem um alerta.
- **Webhook:** o header `X-Telegram-Bot-Api-Secret-Token` é comparado em tempo constante. Sem ele, ou com valor errado, a resposta é 401.
- **Rate limit:** por `telegram_id` nos comandos e por IP e `telegram_id` em `/auth/*`. É em memória, por isolate do Worker: barra abuso comum sem gastar escrita no banco.
- **Logs:** JSON estruturado. O `telegram_id` vira um hash curto e tokens do bot são mascarados nas mensagens de erro.
- **Erros inesperados:** vão para o `ADMIN_CHAT_ID`, no máximo um aviso a cada 10 minutos por origem.
- **Credenciais:** só em secrets do Worker (`wrangler secret put`).
- **Denylist:** é por login da Intra e continua valendo depois de um `/apagar_dados`, para ninguém escapar de um bloqueio apagando os próprios dados.

## Limites do plano gratuito

| Limite                                                | Como o código lida                                                                                                                                                                   |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 50 subrequests por invocação                          | O cron trabalha com um orçamento de 45 e para quando não cabe mais. O que sobra fica para o dia seguinte. Com 400 membros e `REVERIFY_DAYS=30`, são cerca de 14 revalidações por dia |
| Rate limit da API da 42 (2 req/s, 1200 req/h por app) | O cliente espera 600 ms entre chamadas, faz retry com backoff em 429 e 5xx respeitando `Retry-After` e o cron para no primeiro erro persistente                                      |
| Tempo de resposta do webhook                          | A resposta sai em milissegundos. O processamento continua em `waitUntil`                                                                                                             |
| Remoção de membros                                    | `unbanChatMember` sem `only_if_banned` tira a pessoa do grupo sem banir, com 1 chamada por grupo em vez de 2                                                                         |

## Decisões de projeto

**State no D1 em vez do KV.** A spec aceitava as duas opções. O KV é eventualmente consistente, então um `state` apagado ainda pode ser lido em outra região por alguns segundos. No D1, o `DELETE ... RETURNING` garante uso único. De quebra, não consome a cota de 1000 escritas por dia do KV.

**`revoked_reason` em `members`.** Com `AUTO_REMOVE=false`, quem perde o acesso continua no grupo até um admin agir. Sem uma marca no registro, essa pessoa seria aprovada direto no próximo pedido.

**Convites num botão separado.** Gerar convites para 19 grupos custa 19 chamadas. Fazer isso num update próprio mantém o callback do OAuth longe do limite de subrequests.

**Comando `/avisar`.** A spec pede um aviso fixado para membros antigos com prazo, mas não listava um comando para isso.

**PKCE não usado.** Era opcional na spec e não confirmamos suporte na Intra. O state de uso único, o `redirect_uri` fixo e o client secret no servidor cobrem o fluxo.

**TypeScript 7 com ESLint.** O TS 7 ainda não tem API programática, e o typescript-eslint depende dela. O `package.json` usa o arranjo lado a lado recomendado pela Microsoft: `@typescript/native` fornece o `tsc` 7 e o alias `typescript` → `@typescript/typescript6` fornece a API que o ESLint usa.

## Valores a confirmar na API da 42

Todos são configuráveis. Confira antes de ir para produção:

| Item                                      | Valor usado                                            | Como confirmar                          |
| ----------------------------------------- | ------------------------------------------------------ | --------------------------------------- |
| `cursus_id` do 42cursus                   | `21` (`INTRA_MAIN_CURSUS_ID`)                          | `GET /v2/cursus/42cursus`               |
| `cursus_id` da C Piscine                  | `9` (só referência: quem não tem o 42cursus é negado)  | `GET /v2/cursus/c-piscine`              |
| `campus_id` da 42 São Paulo               | `20` (`ALLOWED_CAMPUS_IDS`)                            | `GET /v2/campus?filter[name]=São Paulo` |
| Rate limit do app                         | 2 req/s e 1200 req/h                                   | página do app na Intra                  |
| Convite para a comunidade inteira via bot | não existe na Bot API; o bot gera um convite por grupo |                                         |
