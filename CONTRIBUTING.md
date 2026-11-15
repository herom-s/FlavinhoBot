# Contribuindo

Obrigado por querer ajudar o Flavinho. Este guia mostra como rodar o projeto, testar e mandar um pull request.

## Ambiente

- [Bun](https://bun.sh) 1.2 ou mais novo
- Node 22.5 ou mais novo (o Vitest roda em Node, e os testes usam `node:sqlite`)

```bash
bun install
```

## Comandos

| Comando              | O que faz                                       |
| -------------------- | ----------------------------------------------- |
| `bun run test`       | roda os testes (Vitest)                         |
| `bun run test:watch` | testes em modo watch                            |
| `bun run typecheck`  | `tsc --noEmit` com TypeScript 7                 |
| `bun run lint`       | ESLint e checagem do Prettier                   |
| `bun run format`     | formata tudo com Prettier                       |
| `bun run build`      | gera o bundle do Worker em `dist/` sem publicar |
| `bun run dev`        | sobe o Worker em `http://localhost:8787`        |

O CI roda `typecheck`, `lint`, `test` e `build` em todo pull request. Rode pelo menos os três primeiros antes de abrir o seu.

## Rodando o Worker localmente

```bash
cp .env.example .dev.vars        # preencha com valores de teste
bun run db:migrate:local
bun run dev
```

Para disparar o cron na mão:

```bash
bunx wrangler dev --test-scheduled
curl "http://localhost:8787/__scheduled?cron=0+6+*+*+*"
```

Para testar com o Telegram de verdade, use um bot separado do de produção e exponha o Worker local com um túnel (por exemplo, `cloudflared tunnel --url http://localhost:8787`). Coloque a URL do túnel em `PUBLIC_BASE_URL` e rode `bun run set-webhook`.

## Testes

- [`test/eligibility.test.ts`](test/eligibility.test.ts) cobre cada passo de `avaliarElegibilidade()` com as fixtures em [`test/fixtures/`](test/fixtures).
- [`test/flows.test.ts`](test/flows.test.ts) roda os fluxos ponta a ponta. O [`D1Repository`](src/db/d1Repository.ts) real roda sobre SQLite em memória com as migrations aplicadas, e as APIs do Telegram e da Intra são mocks ([`test/helpers/harness.ts`](test/helpers/harness.ts)).

Mudou uma regra de elegibilidade? Adicione ou ajuste uma fixture e um caso de teste para o ramo novo. Mudou um fluxo? Adicione um teste em `flows.test.ts` usando o `Harness`.

## Padrões do código

- TypeScript strict. Nada de `any`, `@ts-ignore` ou `@ts-expect-error`.
- Regras de negócio ficam em funções puras em `src/domain/`, sem I/O e com o horário recebido como parâmetro.
- Acesso a banco só pela interface `Repository`.
- Textos para usuários ficam em [`src/messages.ts`](src/messages.ts). O tom é o do Flavinho: leve, curto, chama todo mundo de "jovem". "Elegante" só aparece quando falta acesso, nunca em mensagem de sucesso.
- Logs nunca levam tokens, e-mails ou o `telegram_id` cru. Use `hashId()` de [`src/logger.ts`](src/logger.ts).
- Tudo precisa rodar no runtime do Cloudflare Workers: sem APIs exclusivas do Node no código de `src/`.
- Não adicione dependências sem necessidade.

## Migrations

Nunca edite uma migration que já foi aplicada em produção. Crie a próxima em sequência (`migrations/0003_descricao.sql`) e teste com `bun run test`, que aplica todas em ordem.

## Pull requests

1. Crie uma branch a partir da `main`.
2. Faça a mudança com testes.
3. Rode `bun run typecheck && bun run lint && bun run test`.
4. Abra o PR explicando o que mudou e por quê.
