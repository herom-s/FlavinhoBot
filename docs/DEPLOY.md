# Guia de deploy

Este guia coloca o FlavinhoBot no ar do zero: bot no Telegram, app na Intra 42, Worker na Cloudflare e os grupos protegidos. Tudo cabe nos planos gratuitos.

Depois da configuração inicial, o deploy é automático: cada push na `main` passa pelos testes e, se estiver tudo verde, vai para produção pelo GitHub Actions.

**Você vai precisar de:**

- uma conta no Telegram, para falar com o [@BotFather](https://t.me/BotFather)
- uma conta na Intra 42, para criar o app OAuth
- uma conta gratuita na [Cloudflare](https://dash.cloudflare.com/sign-up)
- acesso de admin a este repositório no GitHub (ou ao seu fork)
- [Bun](https://bun.sh) instalado e o repositório clonado (`bun install`), só para os comandos únicos do passo 3

A configuração inicial leva uns 30 minutos.

---

## 1. Criar o bot no Telegram

No [@BotFather](https://t.me/BotFather):

1. `/newbot`, com o nome **FlavinhoBot** e o username **@FlavinhoBot**. Se estiver ocupado, tente `@Flavinho42Bot` ou `@Flavinho42SPBot` (o username precisa terminar em `bot`). Guarde o **token**.
2. `/setdescription` e `/setabouttext`. Exemplo: _"Porteiro da 42 Comunidade. Confirma pela Intra que você é cadete ou alumni e libera a entrada."_
3. `/setuserpic`, com a foto da comunidade.
4. `/setprivacy` → **Enable**. Como o bot é admin nos grupos, ele recebe as mensagens mesmo assim, e é isso que permite registrar quem fala (passo 10).

Os comandos de usuário são registrados pelo próprio deploy, então não precisa usar o `/setcommands`.

## 2. Preparar a Cloudflare

### 2.1 Conta e subdomínio

Crie a conta gratuita. Em **Workers & Pages**, escolha o subdomínio `workers.dev` da sua conta. A URL do bot vai ser:

```
https://flavinhobot.<seu-subdominio>.workers.dev
```

Esse é o seu `PUBLIC_BASE_URL`.

### 2.2 Banco D1

Este é o único comando que precisa rodar na sua máquina:

```bash
bunx wrangler login
bunx wrangler d1 create flavinhobot
```

Guarde o `database_id` da saída. Você não precisa editar o `wrangler.toml`: o deploy injeta o ID a partir de uma variável do GitHub.

Não precisa criar namespace KV: o `state` do OAuth fica numa tabela do D1 (o motivo está em [ARCHITECTURE.md](ARCHITECTURE.md#decisões-de-projeto)).

### 2.3 Account ID e API token

- **Account ID:** aparece em `bunx wrangler whoami` e na barra lateral do painel.
- **API token:** em **My Profile → API Tokens → Create Token**, use o template **Edit Cloudflare Workers** e adicione a permissão **Account → D1 → Edit**. Restrinja à sua conta.

## 3. Criar o app OAuth na Intra 42

Em <https://profile.intra.42.fr/oauth/applications/new>:

| Campo        | Valor                                                            |
| ------------ | ---------------------------------------------------------------- |
| Redirect URI | `https://flavinhobot.<seu-subdominio>.workers.dev/auth/callback` |
| Scopes       | `public`                                                         |

A URL precisa ser exatamente `PUBLIC_BASE_URL` + `/auth/callback`, sem barra no final. Guarde o **UID** e o **SECRET**.

> Antes de divulgar o bot, confirme com a equipe da 42 SP (bocal) se existem regras para apps da comunidade.

## 4. Configurar o GitHub

No repositório, vá em **Settings → Environments → New environment** e crie um environment chamado **`production`**. Opcionalmente, ligue **Required reviewers** para que cada deploy espere a sua aprovação.

Dentro do environment `production`, cadastre:

**Secrets** (Environment secrets)

| Nome                      | Valor                                                 |
| ------------------------- | ----------------------------------------------------- |
| `CLOUDFLARE_API_TOKEN`    | token do passo 2.3                                    |
| `CLOUDFLARE_ACCOUNT_ID`   | account ID do passo 2.3                               |
| `TELEGRAM_BOT_TOKEN`      | token do BotFather                                    |
| `TELEGRAM_WEBHOOK_SECRET` | uma string aleatória. Gere com `openssl rand -hex 32` |
| `INTRA_CLIENT_ID`         | UID do app da Intra                                   |
| `INTRA_CLIENT_SECRET`     | SECRET do app da Intra                                |

**Variables** (Environment variables)

| Nome                 | Valor                                                                                                                       |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `PUBLIC_BASE_URL`    | `https://flavinhobot.<seu-subdominio>.workers.dev`                                                                          |
| `D1_DATABASE_ID`     | `database_id` do passo 2.2                                                                                                  |
| `ADMIN_IDS`          | telegram_ids dos admins, separados por vírgula                                                                              |
| `ADMIN_CHAT_ID`      | chat que recebe os alertas. Pode ser o seu próprio telegram_id (o bot fala com você no privado) ou o ID do grupo dos admins |
| `PROTECTED_CHAT_IDS` | deixe vazio por enquanto. Você preenche no passo 7                                                                          |

Para descobrir seu telegram_id, mande qualquer mensagem para o [@userinfobot](https://t.me/userinfobot). Para receber alertas no privado, mande `/start` para o seu bot uma vez.

Essas variáveis ficam no GitHub, não no código: o repositório pode ser público sem expor IDs de admins e grupos.

## 5. Primeiro deploy

Vá em **Actions → Deploy → Run workflow** (ou faça qualquer push na `main`). O workflow:

1. roda typecheck, lint, testes e o build do Worker
2. confere se todos os secrets e variáveis do passo 4 existem e diz quais faltam
3. aplica as migrations no D1
4. envia os secrets para o Worker e publica o deploy
5. chama `/health` até responder `ok`
6. registra o webhook no Telegram (com o secret) e os comandos de usuário

Se o `CLOUDFLARE_API_TOKEN` ainda não existir, o deploy é pulado com um aviso, sem falhar o workflow.

Quando terminar, confira:

```bash
curl https://flavinhobot.<seu-subdominio>.workers.dev/health
```

A resposta esperada é algo como `{"ok":true,"bot":"FlavinhoBot","chats":0}`. Mande `/start` para o bot no Telegram: ele deve responder com o botão de login.

## 6. Preparar cada grupo da comunidade

Faça isso em **cada** grupo que o bot vai proteger:

1. Deixe o grupo **privado**.
2. Adicione o bot como **admin** com estas permissões:
   - Convidar usuários (`can_invite_users`)
   - Banir usuários (`can_restrict_members`)
   - Apagar mensagens (`can_delete_messages`)
   - Fixar mensagens (recomendado, usado pelo `/avisar`)
3. **Revogue** todos os links antigos de entrada direta.
4. Crie um link de convite com **"Pedir aprovação de admin"** ligado. É esse link que você divulga.
5. Deixe o canal ou tópico de avisos só para admins.

## 7. Proteger os grupos

Quando vira admin num grupo novo, o bot avisa no `ADMIN_CHAT_ID`:

> Fui adicionado ao chat X (id Y). Incluir em PROTECTED_CHAT_IDS?

Você também pode mandar `/chatid` dentro do grupo (só funciona para admins).

Coloque os IDs na variável `PROTECTED_CHAT_IDS` do environment `production`, separados por vírgula (exemplo: `-1001234567890,-1009876543210`), e rode **Actions → Deploy → Run workflow**.

Para proteger um grupo novo no futuro é só repetir os passos 6 e 7, sem mexer no código.

## 8. Descrever cada grupo

O bot explica os grupos para os membros com o `/grupos` e na mensagem de convites. O texto vem da **descrição do próprio grupo no Telegram**: em cada grupo, vá em **Editar → Descrição** e escreva do que ele trata (até 255 caracteres). Exemplo para Eventos:

> Divulgação de eventos da 42 SP e da comunidade: palestras, hackathons, encontros. Avisos importantes ficam fixados.

Depois de editar, mande `/sincronizar` para o bot atualizar na hora. Se esquecer, ele atualiza sozinho no cron diário.

## 9. Conferir as permissões

No privado com o bot, mande `/sincronizar`. Para cada grupo protegido ele responde:

- ✅ tudo certo (com o aviso "sem descrição" se o grupo ainda não tiver descrição)
- ⚠️ falta alguma permissão, ou o grupo é público
- ❌ o bot não é admin ou não tem acesso

## 10. Cuidar de quem já estava nos grupos

A API do Telegram não lista os membros de um grupo. Por isso o bot registra quem fala ou entra depois que ele chega.

1. Mande `/avisar`. O bot posta e fixa em todos os grupos um aviso pedindo `/start` no privado até a data limite (`GRANDFATHER_DAYS`).
2. Acompanhe com `/nao_verificados`.
3. Depois do prazo, o cron diário manda a lista de não verificados para os admins. Com `AUTO_REMOVE=true`, ele remove essas pessoas sem banir e manda uma DM explicando como voltar.

Quem nunca fala nem entra depois da chegada do bot não aparece na lista. Essa é uma limitação do Telegram.

---

## Ajustes de comportamento

Os valores abaixo ficam na seção `[vars]` do [`wrangler.toml`](../wrangler.toml), porque não são sensíveis. Mude, faça o commit e o deploy aplica.

| Variável                     | Padrão no `wrangler.toml` | O que é                                                                    |
| ---------------------------- | ------------------------- | -------------------------------------------------------------------------- |
| `ALLOWED_CAMPUS_IDS`         | `20`                      | campus aceitos. `20` é a 42 São Paulo. Vazio aceita qualquer campus        |
| `ALLOW_STAFF`                | `true`                    | libera contas de staff da 42                                               |
| `REVERIFY_DAYS`              | `30`                      | por quantos dias uma verificação vale                                      |
| `AUTO_REMOVE`                | `false`                   | remove automaticamente quem perdeu o acesso. Desligado, só avisa os admins |
| `JOIN_REQUEST_TIMEOUT_HOURS` | `24`                      | depois disso, pedidos não concluídos são recusados                         |
| `GRANDFATHER_DAYS`           | `14`                      | prazo para quem já estava nos grupos verificar                             |
| `INTRA_MAIN_CURSUS_ID`       | `21`                      | ID do 42cursus                                                             |
| `REVERIFY_MAX_PER_RUN`       | `30`                      | máximo de revalidações por execução do cron                                |

Se alguma variável estiver faltando ou inválida, o Worker responde 500 e o log diz exatamente qual é.

## CI/CD

| Workflow                                        | Quando roda                     | O que faz                                               |
| ----------------------------------------------- | ------------------------------- | ------------------------------------------------------- |
| [`ci.yml`](../.github/workflows/ci.yml)         | em todo pull request            | typecheck, lint, testes e build do Worker               |
| [`deploy.yml`](../.github/workflows/deploy.yml) | em push na `main` e manualmente | roda o CI e, se passar, faz o deploy completo (passo 5) |
| [`dependabot.yml`](../.github/dependabot.yml)   | toda semana                     | abre PRs atualizando dependências e actions             |

Deploys nunca rodam em paralelo, e um deploy em andamento não é cancelado por um push novo.

Para desfazer um deploy ruim: **Cloudflare → Workers & Pages → flavinhobot → Deployments → Rollback**, ou `bunx wrangler rollback`. Migrations não são revertidas automaticamente, então escreva migrations que só adicionam coisas.

## Deploy manual (sem GitHub Actions)

Se preferir publicar da sua máquina:

```bash
# uma vez: cole o database_id no wrangler.toml e preencha as [vars]
bunx wrangler secret put TELEGRAM_BOT_TOKEN
bunx wrangler secret put TELEGRAM_WEBHOOK_SECRET
bunx wrangler secret put INTRA_CLIENT_ID
bunx wrangler secret put INTRA_CLIENT_SECRET

# a cada deploy
bun run db:migrate:remote
bun run deploy

# webhook e comandos (lê TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET e PUBLIC_BASE_URL do .env)
cp .env.example .env
bun run set-webhook
```

O `.env` está no `.gitignore`. Não commite, e não commite o `wrangler.toml` com IDs de admins se o repositório for público.

---

## Antes de divulgar

- [ ] Troque os links de exemplo em [`config/links.json`](../config/links.json) (Guia de Sobrevivência e Plano de Estudos) pelas URLs reais.
- [ ] Confirme os IDs que a spec marcou para validar. Veja a tabela em [ARCHITECTURE.md](ARCHITECTURE.md#valores-a-confirmar-na-api-da-42).
- [ ] Teste o fluxo com uma conta de admin: pedir para entrar, verificar, entrar em um segundo grupo.
- [ ] Rode `/stats` e `/sincronizar`.

## Lançamento

1. Admins e staff entram primeiro para testar o fluxo.
2. Divulgue o link `t.me/FlavinhoBot?start=entrar`, com a frase "a entrada é validada pela Intra, leva 30 segundos".
3. Acompanhe `/stats` e `/pendentes` e use `/allow` para destravar casos especiais.

## Problemas comuns

**O deploy falhou em "Conferir configuração".** O log lista exatamente quais secrets ou variáveis faltam no environment `production`.

**O deploy falhou nas migrations ou no deploy com erro de autenticação.** O API token precisa do template "Edit Cloudflare Workers" e da permissão D1 Edit, e o `CLOUDFLARE_ACCOUNT_ID` precisa ser da mesma conta.

**O bot não responde a nada.** Rode o workflow de deploy de novo: o último passo registra o webhook e imprime o `getWebhookInfo`. Um `last_error_message` com 401 indica secret do webhook diferente entre o Telegram e o Worker.

**`/health` responde 500.** Alguma variável está faltando ou inválida. Veja os logs com `bunx wrangler tail` ou no painel da Cloudflare.

**A Intra mostra "redirect_uri is invalid".** O Redirect URI do app precisa ser exatamente `PUBLIC_BASE_URL/auth/callback`, sem barra no final.

**Pedidos de entrada não chegam.** O link do grupo precisa ter "Pedir aprovação de admin" ligado, o bot precisa ser admin com `can_invite_users` e o ID do grupo precisa estar em `PROTECTED_CHAT_IDS`. O `/sincronizar` aponta o que falta.

**A pessoa verificou mas não recebeu a DM.** O Telegram só deixa o bot mandar DM para quem pediu para entrar por 5 minutos e até o pedido ser processado. A página de retorno da Intra mostra o resultado de qualquer forma, e `/start` no privado entrega os convites.
