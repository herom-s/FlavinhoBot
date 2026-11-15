import { escapeHtml } from "../messages";

export interface PageLink {
  label: string;
  url: string;
}

/** Página simples, sem JS e sem recursos externos. `body` já deve vir escapado. */
export function page(title: string, body: string, status = 200, links: PageLink[] = []): Response {
  const linkList = links.length
    ? `<ul>${links
        .map((l) => `<li><a href="${escapeHtml(l.url)}">${escapeHtml(l.label)}</a></li>`)
        .join("")}</ul>`
    : "";
  const html = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)} · FlavinhoBot</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, sans-serif; max-width: 34rem; margin: 0 auto; padding: 3rem 1.25rem; line-height: 1.5; }
  h1 { font-size: 1.5rem; margin: 0 0 .75rem; }
  a { color: #2aabee; }
  ul { padding-left: 1.2rem; }
  .btn { display: inline-block; margin-top: 1rem; padding: .7rem 1.1rem; border-radius: .5rem; background: #2aabee; color: #fff; text-decoration: none; font-weight: 600; }
</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
${body}
${linkList}
</body>
</html>`;
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
    },
  });
}

export const paragraph = (text: string): string => `<p>${escapeHtml(text)}</p>`;

export const button = (label: string, url: string): string =>
  `<a class="btn" href="${escapeHtml(url)}">${escapeHtml(label)}</a>`;
