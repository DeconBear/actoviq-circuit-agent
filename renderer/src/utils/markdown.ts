import hljs from 'highlight.js';
import { Marked, Renderer, type Tokens } from 'marked';

interface MarkdownParserOptions {
  codeBlockClassName?: string;
  highlightCode?: boolean;
  showLanguageLabel?: boolean;
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeAttribute(value: string): string {
  return escapeHtml(value).replace(/`/g, '&#96;');
}

function safeHref(href: string): string | null {
  const trimmed = href.trim();
  const normalized = trimmed.replace(/[\u0000-\u001F\u007F\s]+/g, '');
  if (/^(?:javascript|data|vbscript):/i.test(normalized)) {
    return null;
  }
  return trimmed;
}

function safeLanguage(lang: string | undefined): string {
  return (lang ?? '').trim().split(/\s+/)[0]?.replace(/[^A-Za-z0-9_+-]/g, '') ?? '';
}

function renderCode(text: string, lang: string | undefined, highlightCode: boolean): string {
  const language = safeLanguage(lang);
  if (!highlightCode) {
    return escapeHtml(text);
  }
  try {
    if (language && hljs.getLanguage(language)) {
      return hljs.highlight(text, { language }).value;
    }
    return hljs.highlightAuto(text).value;
  } catch {
    return escapeHtml(text);
  }
}

export function createSafeMarkdownParser(options: MarkdownParserOptions = {}): Marked {
  const renderer = new Renderer();

  renderer.html = ({ text }: Tokens.HTML | Tokens.Tag) => escapeHtml(text);

  renderer.code = ({ text, lang }: Tokens.Code) => {
    const language = safeLanguage(lang);
    const code = renderCode(text, language, options.highlightCode ?? false);
    const classAttr = language ? ` class="language-${safeAttribute(language)}"` : '';
    const langLabel = options.showLanguageLabel && language
      ? `<span class="code-lang">${escapeHtml(language)}</span>`
      : '';
    const pre = `<pre><code${classAttr}>${code}</code></pre>`;
    if (!options.codeBlockClassName) {
      return pre;
    }
    return `<div class="${safeAttribute(options.codeBlockClassName)}">${langLabel}${pre}</div>`;
  };

  renderer.link = function ({ href, title, tokens }: Tokens.Link) {
    const text = this.parser.parseInline(tokens) as string;
    const resolvedHref = safeHref(href);
    if (!resolvedHref) {
      return text;
    }
    const titleAttr = title ? ` title="${safeAttribute(title)}"` : '';
    return `<a href="${safeAttribute(resolvedHref)}"${titleAttr} target="_blank" rel="noreferrer">${text}</a>`;
  };

  renderer.image = ({ href, title, text }: Tokens.Image) => {
    const resolvedHref = safeHref(href);
    if (!resolvedHref) {
      return escapeHtml(text);
    }
    const titleAttr = title ? ` title="${safeAttribute(title)}"` : '';
    return `<img src="${safeAttribute(resolvedHref)}" alt="${safeAttribute(text)}"${titleAttr}>`;
  };

  return new Marked({
    renderer,
    breaks: true,
    gfm: true,
  });
}
