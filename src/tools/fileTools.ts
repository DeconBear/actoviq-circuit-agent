import { mkdir, open, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { tool, type AgentToolDefinition } from 'actoviq-agent-sdk';
import { z } from 'zod';

interface WorkspaceFileToolsOptions {
  cwd: string;
  allowedRoots: string[];
  maxReadLines?: number;
  defaultGlobLimit?: number;
  defaultGrepLimit?: number;
}

interface ReadToolOutput {
  filePath: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  truncated: boolean;
  content: string;
}

interface WriteToolOutput {
  type: 'create' | 'update';
  filePath: string;
  bytesWritten: number;
}

interface EditToolOutput {
  filePath: string;
  replacements: number;
  mode?: 'exact' | 'normalized_line_endings';
}

interface GlobToolOutput {
  root: string;
  filenames: string[];
  numFiles: number;
}

interface GrepFilesOutput {
  mode: 'files_with_matches';
  filenames: string[];
}

interface GrepCountOutput {
  mode: 'count';
  counts: string[];
}

interface GrepContentOutput {
  mode: 'content';
  lines: string[];
}

type GrepToolOutput = GrepFilesOutput | GrepCountOutput | GrepContentOutput;
type ToolInputAliases = Record<string, string[]>;

const DEFAULT_MAX_READ_LINES = 2000;
const DEFAULT_MAX_READ_BYTES = 2_000_000;
const DEFAULT_GLOB_LIMIT = 100;
const DEFAULT_GREP_LIMIT = 250;

function normalizePath(filePath: string): string {
  return path.resolve(filePath);
}

function resolveToolPath(filePath: string, cwd: string): string {
  return path.isAbsolute(filePath) ? normalizePath(filePath) : path.resolve(cwd, filePath);
}

function isPathInside(root: string, candidate: string): boolean {
  const normalizedRoot = normalizePath(root);
  const normalizedCandidate = normalizePath(candidate);
  const relative = path.relative(normalizedRoot, normalizedCandidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function ensureAllowedPath(filePath: string, allowedRoots: string[], cwd: string): string {
  const resolved = resolveToolPath(filePath, cwd);
  if (!allowedRoots.some((root) => isPathInside(root, resolved))) {
    throw new Error(`Path is outside allowed roots: ${resolved}`);
  }
  return resolved;
}

function formatWithLineNumbers(text: string, offset = 1): string {
  const lines = text.split(/\r?\n/);
  return lines
    .map((line, index) => `${String(offset + index).padStart(6, ' ')}\t${line}`)
    .join('\n');
}

async function readUtf8Prefix(filePath: string, maxBytes: number): Promise<string> {
  const handle = await open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

function globToRegExp(pattern: string): RegExp {
  const normalized = pattern.replace(/\\/g, '/');
  let regex = '^';
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index]!;
    const next = normalized[index + 1];
    if (char === '*' && next === '*') {
      regex += '.*';
      index += 1;
      continue;
    }
    if (char === '*') {
      regex += '[^/]*';
      continue;
    }
    if (char === '?') {
      regex += '.';
      continue;
    }
    if ('\\.[]{}()+-^$|'.includes(char)) {
      regex += `\\${char}`;
      continue;
    }
    regex += char;
  }
  regex += '$';
  return new RegExp(regex, 'i');
}

async function listFilesRecursively(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const results: string[] = [];
  for (const entry of entries) {
    const fullPath = path.resolve(root, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await listFilesRecursively(fullPath)));
      continue;
    }
    if (entry.isFile()) {
      results.push(fullPath);
    }
  }
  return results;
}

function makeRelativeDisplay(searchRoot: string, filePath: string): string {
  return path.relative(searchRoot, filePath).replace(/\\/g, '/');
}

function replaceFirst(source: string, oldText: string, newText: string): string {
  const index = source.indexOf(oldText);
  if (index < 0) {
    throw new Error('old_string was not found');
  }
  return `${source.slice(0, index)}${newText}${source.slice(index + oldText.length)}`;
}

function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function applyLimit<T>(items: T[], limit: number, offset: number): T[] {
  const start = Math.max(0, offset);
  if (limit <= 0) {
    return items.slice(start);
  }
  return items.slice(start, start + limit);
}

function normalizeAliasedFields(input: Record<string, unknown>, aliases: ToolInputAliases): Record<string, unknown> {
  const normalized = { ...input };
  for (const [canonicalKey, aliasKeys] of Object.entries(aliases)) {
    if (normalized[canonicalKey] !== undefined) {
      continue;
    }
    for (const aliasKey of aliasKeys) {
      if (normalized[aliasKey] !== undefined) {
        normalized[canonicalKey] = normalized[aliasKey];
        break;
      }
    }
  }
  return normalized;
}

function unescapeLooseString(value: string): string {
  return value
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\');
}

function unescapeLoosePathString(value: string): string {
  return value.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
}

function findLooseStringField(
  raw: string,
  keys: string[],
  consumeToEnd = false,
  decode: (value: string) => string = unescapeLooseString,
): string | undefined {
  for (const key of keys) {
    const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const keyPattern = new RegExp(`(?:["']${escapedKey}["']|\\b${escapedKey}\\b)\\s*:`, 'i');
    const keyMatch = keyPattern.exec(raw);
    if (!keyMatch || keyMatch.index === undefined) {
      continue;
    }

    const colonIndex = raw.indexOf(':', keyMatch.index + keyMatch[0].length - 1);
    const firstQuote = raw.indexOf('"', colonIndex + 1);
    if (colonIndex < 0) {
      continue;
    }

    if (firstQuote < 0) {
      const rest = raw.slice(colonIndex + 1);
      const line = rest.split(/\r?\n/, 1)[0]?.trim().replace(/,$/, '');
      if (line) {
        return decode(line.replace(/^['"]|['"]$/g, ''));
      }
      continue;
    }

    if (consumeToEnd) {
      const trimmed = raw.trimEnd();
      const objectEnd = trimmed.endsWith('}') ? trimmed.lastIndexOf('}') : trimmed.length;
      const lastQuote = trimmed.lastIndexOf('"', objectEnd - 1);
      if (lastQuote > firstQuote) {
        return decode(trimmed.slice(firstQuote + 1, lastQuote));
      }
    }

    for (let index = firstQuote + 1; index < raw.length; index += 1) {
      if (raw[index] !== '"') {
        continue;
      }
      let slashCount = 0;
      for (let cursor = index - 1; cursor > firstQuote && raw[cursor] === '\\'; cursor -= 1) {
        slashCount += 1;
      }
      if (slashCount % 2 === 0) {
        return decode(raw.slice(firstQuote + 1, index));
      }
    }
  }
  return undefined;
}

function stripMarkdownFence(raw: string): string {
  const trimmed = raw.trim();
  const fenceMatch = /^```(?:json|javascript|js|ts|typescript)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return fenceMatch?.[1]?.trim() ?? raw;
}

function extractJsonObject(raw: string): string | null {
  const candidate = stripMarkdownFence(raw);
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) {
    return null;
  }
  return candidate.slice(start, end + 1);
}

function parseLooseRawObject(raw: string): Record<string, unknown> | null {
  const fenced = stripMarkdownFence(raw);
  const jsonObject = extractJsonObject(raw);
  const candidates = [
    raw,
    fenced,
    jsonObject,
    raw.replace(/\\"/g, '"'),
    fenced.replace(/\\"/g, '"'),
    jsonObject?.replace(/\\"/g, '"') ?? null,
  ].filter((candidate): candidate is string => Boolean(candidate));
  for (const candidate of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const nested = parseLooseWriteInputFromWrappers(parsed);
        return nested ?? (parsed as Record<string, unknown>);
      }
      if (typeof parsed === 'string' && parsed !== candidate) {
        const nested = parseLooseRawObject(parsed);
        if (nested) {
          return nested;
        }
      }
    } catch {
      // Fall through to tolerant field extraction.
    }

    const loose = parseLooseRawObjectCandidate(candidate);
    if (loose) {
      return loose;
    }
  }
  return null;
}

function parseLooseRawObjectCandidate(raw: string): Record<string, unknown> | null {
  const filePath = findLooseStringField(raw, [
    'file_path',
    'filePath',
    'filepath',
    'path',
    'filename',
    'fileName',
    'file',
    'target',
    'targetPath',
    'target_path',
    'output',
    'outputPath',
    'output_path',
    'destination',
    'destinationPath',
  ], false, unescapeLoosePathString);
  const content = findLooseStringField(raw, [
    'content',
    'contents',
    'text',
    'body',
    'data',
    'markdown',
    'markdownContent',
    'markdown_content',
    'value',
    'fileContent',
    'file_content',
    'document',
    'doc',
  ], true);

  if (!filePath || content === undefined) {
    return null;
  }
  return {
    file_path: filePath,
    content,
  };
}

function decodeWrappedToolInput(input: unknown): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return input;
  }

  const record = input as Record<string, unknown>;
  for (const wrapperKey of ['raw', 'input', 'arguments', 'payload']) {
    const wrapped = record[wrapperKey];
    if (typeof wrapped === 'string') {
      try {
        return JSON.parse(wrapped);
      } catch {
        const loose = parseLooseRawObject(wrapped);
        if (loose) {
          return loose;
        }
        return input;
      }
    }
    if (wrapped && typeof wrapped === 'object' && !Array.isArray(wrapped)) {
      return wrapped;
    }
  }

  return input;
}

function buildToolWrapperFields() {
  return {
    raw: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
    input: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
    arguments: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
    payload: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
  };
}

function withCompatibleToolInput<T extends z.ZodRawShape>(
  schema: z.ZodObject<T>,
  requiredKeys: Array<keyof T & string>,
  aliases: ToolInputAliases = {},
): z.ZodObject<T> {
  return schema
    .partial()
    .extend(buildToolWrapperFields())
    .passthrough()
    .refine((value) => {
      if (
        value.raw !== undefined ||
        value.input !== undefined ||
        value.arguments !== undefined ||
        value.payload !== undefined
      ) {
        return true;
      }
      return requiredKeys.every((key) => {
        const record = value as Record<string, unknown>;
        if (value[key] !== undefined) {
          return true;
        }
        return (aliases[key] ?? []).some((aliasKey) => record[aliasKey] !== undefined);
      });
    }, {
      message: `Expected canonical tool arguments: ${requiredKeys.join(', ')}.`,
    }) as unknown as z.ZodObject<T>;
}

function parseCompatibleToolInput<T extends z.ZodTypeAny>(
  input: unknown,
  schema: T,
  aliases: ToolInputAliases = {},
): z.output<T> {
  const decoded = decodeWrappedToolInput(input);
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
    return schema.parse(decoded);
  }
  return schema.parse(normalizeAliasedFields(decoded as Record<string, unknown>, aliases));
}

function asToolInputRecord(input: unknown): Record<string, unknown> {
  const decoded = decodeWrappedToolInput(input);
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
    throw new Error(`Expected object tool input, received ${typeof decoded}`);
  }
  return decoded as Record<string, unknown>;
}

const WRITE_RETRY_GUIDANCE = [
  'Tool retry guidance:',
  'Retry the Write call with top-level JSON exactly like {"file_path":"ABSOLUTE_OUTPUT_PATH","content":"FULL_FILE_CONTENT"}.',
  'Do not wrap Write arguments inside raw, input, arguments, or payload.',
  'Use the absolute output path from the stage packet and include the complete file content.',
].join('\n');

function normalizeWriteInputForSchema(input: unknown, aliases: ToolInputAliases): unknown {
  try {
    const decoded = asToolInputRecord(input);
    const normalized = normalizeAliasedFields(decoded, aliases);
    if (normalized.file_path !== undefined && normalized.content !== undefined) {
      return normalized;
    }
  } catch {
    // Fall through to wrapper/raw recovery.
  }

  const loose = parseLooseWriteInputFromWrappers(input);
  return loose ? normalizeAliasedFields(loose, aliases) : input;
}

function createWriteInputError(message: string): Error {
  return new Error(`${message}\n${WRITE_RETRY_GUIDANCE}`);
}

function stringifyToolContent(value: unknown, fieldName: string): string {
  if (typeof value === 'string') {
    return value;
  }
  if (value === undefined || value === null) {
    throw createWriteInputError(`Missing required Write field: ${fieldName}`);
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function parseLooseWriteInputFromWrappers(input: unknown): Record<string, unknown> | null {
  if (typeof input === 'string') {
    return parseLooseRawObject(input);
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return null;
  }

  const record = input as Record<string, unknown>;
  for (const wrapperKey of ['raw', 'input', 'arguments', 'payload']) {
    const wrapped = record[wrapperKey];
    if (typeof wrapped === 'string') {
      const parsed = parseLooseRawObject(wrapped);
      if (parsed) {
        return parsed;
      }
    }
    if (wrapped && typeof wrapped === 'object' && !Array.isArray(wrapped)) {
      const nested = parseLooseWriteInputFromWrappers(wrapped);
      if (nested) {
        return nested;
      }
      return wrapped as Record<string, unknown>;
    }
  }

  return null;
}

function parseWriteToolInput(input: unknown, aliases: ToolInputAliases): { file_path: string; content: string } {
  let normalized: Record<string, unknown>;
  try {
    normalized = normalizeAliasedFields(asToolInputRecord(input), aliases);
  } catch (error) {
    const loose = parseLooseWriteInputFromWrappers(input);
    if (!loose) {
      const message = error instanceof Error ? error.message : String(error);
      throw createWriteInputError(message);
    }
    normalized = normalizeAliasedFields(loose, aliases);
  }

  if (normalized.file_path === undefined || normalized.content === undefined) {
    const loose = parseLooseWriteInputFromWrappers(input);
    if (loose) {
      normalized = normalizeAliasedFields({ ...normalized, ...loose }, aliases);
    }
  }

  const filePath = normalized.file_path;
  if (typeof filePath !== 'string' || filePath.trim().length === 0) {
    const availableKeys = Object.keys(normalized).sort().join(', ') || '(none)';
    throw createWriteInputError(`Missing required Write field: file_path. Available input keys: ${availableKeys}`);
  }
  return {
    file_path: filePath,
    content: stringifyToolContent(normalized.content, 'content'),
  };
}

export function createWorkspaceFileTools(options: WorkspaceFileToolsOptions): AgentToolDefinition[] {
  const cwd = normalizePath(options.cwd);
  const allowedRoots = [...new Set([cwd, ...options.allowedRoots.map((root) => normalizePath(root))])];
  const maxReadLines = options.maxReadLines ?? DEFAULT_MAX_READ_LINES;
  const maxReadBytes = DEFAULT_MAX_READ_BYTES;
  const defaultGlobLimit = options.defaultGlobLimit ?? DEFAULT_GLOB_LIMIT;
  const defaultGrepLimit = options.defaultGrepLimit ?? DEFAULT_GREP_LIMIT;
  const readBaseSchema = z.object({
    file_path: z.string().describe('Absolute path to the file to read.'),
    offset: z.number().int().positive().optional(),
    limit: z.number().int().positive().optional(),
  });
  const writeBaseSchema = z.object({
    file_path: z.string().describe('Absolute path to the file to write.'),
    content: z.string().describe('Full file content.'),
  });
  const editBaseSchema = z.object({
    file_path: z.string().describe('Absolute path to the file to edit.'),
    old_string: z.string().describe('The exact string to replace.'),
    new_string: z.string().describe('Replacement text.'),
    replace_all: z.boolean().optional().default(false),
  });
  const globBaseSchema = z.object({
    pattern: z.string().describe('Glob pattern, for example **/*.ts'),
    path: z.string().optional().describe('Absolute directory to search in. Defaults to the workflow cwd.'),
    limit: z.number().int().positive().optional(),
  });
  const grepBaseSchema = z.object({
    pattern: z.string().describe('Regular expression to search for.'),
    path: z.string().optional().describe('Absolute file or directory path to search in.'),
    glob: z.string().optional().describe('Optional glob filter for searched files.'),
    output_mode: z.enum(['content', 'files_with_matches', 'count']).optional().default('files_with_matches'),
    head_limit: z.number().int().nonnegative().optional(),
    offset: z.number().int().nonnegative().optional().default(0),
    '-i': z.boolean().optional().default(false),
    '-n': z.boolean().optional().default(true),
  });
  const readAliases = {
    file_path: ['filePath', 'filepath', 'path', 'filename', 'fileName', 'file'],
  };
  const writeAliases = {
    file_path: [
      'filePath',
      'filepath',
      'path',
      'filename',
      'fileName',
      'file',
      'target',
      'targetPath',
      'target_path',
      'output',
      'outputPath',
      'output_path',
      'destination',
      'destinationPath',
    ],
    content: [
      'contents',
      'text',
      'body',
      'data',
      'markdown',
      'markdownContent',
      'markdown_content',
      'value',
      'fileContent',
      'file_content',
      'document',
      'doc',
    ],
  };
  const editAliases = {
    file_path: ['filePath', 'path'],
    old_string: ['oldString', 'oldText', 'old'],
    new_string: ['newString', 'newText', 'new'],
    replace_all: ['replaceAll'],
  };
  const globAliases = { path: ['root', 'searchPath'] };
  const grepAliases = {
    path: ['filePath', 'searchPath'],
    output_mode: ['outputMode'],
    head_limit: ['headLimit', 'limit'],
  };
  const readInputSchema = withCompatibleToolInput(readBaseSchema, ['file_path'], readAliases);
  const writeInputSchema = z.preprocess(
    (input) => normalizeWriteInputForSchema(input, writeAliases),
    z.object({
      ...buildToolWrapperFields(),
      file_path: z.unknown().optional().describe('Canonical absolute path to the file to write. Required at execution time.'),
      content: z.unknown().optional().describe('Canonical full file content. Required at execution time.'),
    }).passthrough(),
  );
  const editInputSchema = withCompatibleToolInput(editBaseSchema, ['file_path', 'old_string', 'new_string'], editAliases);
  const globInputSchema = withCompatibleToolInput(globBaseSchema, ['pattern'], globAliases);
  const grepInputSchema = withCompatibleToolInput(grepBaseSchema, ['pattern'], grepAliases);

  const Read = tool(
    {
      name: 'Read',
      description: 'Read a UTF-8 text file from the local filesystem and return numbered lines.',
      inputSchema: readInputSchema,
      serialize: (output) => (output as ReadToolOutput).content,
    },
    async (input) => {
      const { file_path, offset, limit } = parseCompatibleToolInput(input, readBaseSchema, readAliases);
      const resolved = ensureAllowedPath(file_path, allowedRoots, cwd);
      const fileStats = await stat(resolved);
      if (!fileStats.isFile()) {
        throw new Error(`Path is not a file: ${resolved}`);
      }
      const isOversized = fileStats.size > maxReadBytes;
      const text = isOversized ? await readUtf8Prefix(resolved, maxReadBytes) : await readFile(resolved, 'utf8');
      const lines = text.split(/\r?\n/);
      const startLine = Math.max(1, offset ?? 1);
      const readLimit = limit ?? maxReadLines;
      const selected = lines.slice(startLine - 1, startLine - 1 + readLimit);
      const prefix = isOversized
        ? `File is ${fileStats.size} bytes; showing only the first ${maxReadBytes} bytes. Use a more specific smaller file or generated metrics JSON for full analysis.\n`
        : '';
      return {
        filePath: resolved,
        startLine,
        endLine: startLine + selected.length - 1,
        totalLines: lines.length,
        truncated: isOversized || startLine - 1 + selected.length < lines.length,
        content: `${prefix}${formatWithLineNumbers(selected.join('\n'), startLine)}`,
      };
    },
  );

  const Write = tool(
    {
      name: 'Write',
      description: 'Write a UTF-8 text file to the local filesystem. Canonical input is {"file_path":"ABSOLUTE_OUTPUT_PATH","content":"FULL_FILE_CONTENT"}. Creates or replaces the full file content.',
      inputSchema: writeInputSchema,
      serialize: (output) => {
        const typed = output as WriteToolOutput;
        return `${typed.type === 'create' ? 'Created' : 'Updated'} ${typed.filePath}`;
      },
    },
    async (input) => {
      const { file_path, content } = parseWriteToolInput(input, writeAliases);
      const resolved = ensureAllowedPath(file_path, allowedRoots, cwd);
      const existing = await stat(resolved).catch(() => null);
      await mkdir(path.dirname(resolved), { recursive: true });
      await writeFile(resolved, content, 'utf8');
      return {
        type: existing?.isFile() ? 'update' : 'create',
        filePath: resolved,
        bytesWritten: Buffer.byteLength(content, 'utf8'),
      };
    },
  );

  const Edit = tool(
    {
      name: 'Edit',
      description: 'Edit a file in place by replacing one string with another.',
      inputSchema: editInputSchema,
      serialize: (output) => {
        const typed = output as EditToolOutput;
        return `Edited ${typed.filePath} (${typed.replacements} replacement${typed.replacements === 1 ? '' : 's'})`;
      },
    },
    async (input) => {
      const { file_path, old_string, new_string, replace_all } = parseCompatibleToolInput(input, editBaseSchema, editAliases);
      const resolved = ensureAllowedPath(file_path, allowedRoots, cwd);
      const original = await readFile(resolved, 'utf8');
      const occurrences = original.split(old_string).length - 1;
      if (occurrences === 0) {
        const normalizedOriginal = normalizeLineEndings(original);
        const normalizedOld = normalizeLineEndings(old_string);
        const normalizedNew = normalizeLineEndings(new_string);
        const normalizedOccurrences = normalizedOriginal.split(normalizedOld).length - 1;
        if (normalizedOccurrences === 0) {
          throw new Error(
            [
              `old_string was not found in ${resolved}.`,
              'The file may have changed since it was read, or the string may differ in whitespace.',
              'Read the file again and either provide an exact old_string or use Write to replace the full file content.',
            ].join(' '),
          );
        }
        if (!replace_all && normalizedOccurrences > 1) {
          throw new Error(
            `old_string matched ${normalizedOccurrences} locations after normalizing line endings in ${resolved}. Use replace_all: true or provide a more specific old_string.`,
          );
        }
        const updated = replace_all
          ? normalizedOriginal.split(normalizedOld).join(normalizedNew)
          : replaceFirst(normalizedOriginal, normalizedOld, normalizedNew);
        await writeFile(resolved, updated, 'utf8');
        return {
          filePath: resolved,
          replacements: replace_all ? normalizedOccurrences : 1,
          mode: 'normalized_line_endings',
        };
      }
      if (!replace_all && occurrences > 1) {
        throw new Error(
          `old_string matched ${occurrences} locations in ${resolved}. Use replace_all: true or provide a more specific old_string.`,
        );
      }
      const updated = replace_all
        ? original.split(old_string).join(new_string)
        : replaceFirst(original, old_string, new_string);
      await writeFile(resolved, updated, 'utf8');
      return {
        filePath: resolved,
        replacements: replace_all ? occurrences : 1,
        mode: 'exact',
      };
    },
  );

  const Glob = tool(
    {
      name: 'Glob',
      description: 'Find files by glob pattern within allowed roots.',
      inputSchema: globInputSchema,
      serialize: (output) => {
        const typed = output as GlobToolOutput;
        return typed.filenames.length > 0 ? typed.filenames.join('\n') : 'No files found';
      },
    },
    async (input) => {
      const { pattern, path: searchPath, limit } = parseCompatibleToolInput(input, globBaseSchema, globAliases);
      const searchRoot = ensureAllowedPath(searchPath ?? cwd, allowedRoots, cwd);
      const matcher = globToRegExp(pattern);
      const allFiles = await listFilesRecursively(searchRoot);
      const matched = allFiles
        .filter((file) => matcher.test(makeRelativeDisplay(searchRoot, file)))
        .map((file) => makeRelativeDisplay(searchRoot, file))
        .sort();
      const paged = applyLimit(matched, limit ?? defaultGlobLimit, 0);
      return {
        root: searchRoot,
        filenames: paged,
        numFiles: paged.length,
      };
    },
  );

  const Grep = tool(
    {
      name: 'Grep',
      description: 'Search file contents with a regular expression.',
      inputSchema: grepInputSchema,
      serialize: (output) => {
        const typed = output as GrepToolOutput;
        if (typed.mode === 'files_with_matches') {
          return typed.filenames.length > 0 ? typed.filenames.join('\n') : 'No matches';
        }
        if (typed.mode === 'count') {
          return typed.counts.length > 0 ? typed.counts.join('\n') : 'No matches';
        }
        return typed.lines.length > 0 ? typed.lines.join('\n') : 'No matches';
      },
    },
    async (input) => {
      const parsed = parseCompatibleToolInput(input, grepBaseSchema, grepAliases);
      const searchRoot = ensureAllowedPath(parsed.path ?? cwd, allowedRoots, cwd);
      const stats = await stat(searchRoot).catch(() => null);
      if (!stats) {
        throw new Error(`Search path does not exist: ${searchRoot}`);
      }

      const regex = new RegExp(parsed.pattern, parsed['-i'] ? 'i' : undefined);
      const globRegex = parsed.glob ? globToRegExp(parsed.glob) : null;
      const allFiles = stats.isDirectory() ? await listFilesRecursively(searchRoot) : [searchRoot];

      const filteredFiles = allFiles.filter((file) => {
        if (!globRegex) {
          return true;
        }
        return globRegex.test(makeRelativeDisplay(stats.isDirectory() ? searchRoot : path.dirname(searchRoot), file));
      });

      const mode = parsed.output_mode ?? 'files_with_matches';
      const limit = parsed.head_limit ?? defaultGrepLimit;
      const offset = parsed.offset ?? 0;

      const fileMatches: string[] = [];
      const lineMatches: string[] = [];
      const countMatches: string[] = [];

      for (const file of filteredFiles) {
        const relative = makeRelativeDisplay(stats.isDirectory() ? searchRoot : path.dirname(searchRoot), file);
        const currentStats = await stat(file).catch(() => null);
        if (currentStats && currentStats.size > maxReadBytes) {
          const skipped = `${relative}: skipped oversized file (${currentStats.size} bytes > ${maxReadBytes} bytes)`;
          if (mode === 'content') {
            lineMatches.push(skipped);
          } else if (mode === 'count') {
            countMatches.push(skipped);
          }
          continue;
        }

        const content = await readFile(file, 'utf8');
        if (mode === 'files_with_matches') {
          if (regex.test(content)) {
            fileMatches.push(relative);
          }
          continue;
        }

        if (mode === 'count') {
          const count = [...content.matchAll(new RegExp(parsed.pattern, `${parsed['-i'] ? 'gi' : 'g'}`))].length;
          if (count > 0) {
            countMatches.push(`${relative}:${count}`);
          }
          continue;
        }

        const lines = content.split(/\r?\n/);
        for (let index = 0; index < lines.length; index += 1) {
          if (!regex.test(lines[index] ?? '')) {
            continue;
          }
          const prefix = parsed['-n'] === false ? `${relative}:` : `${relative}:${index + 1}:`;
          lineMatches.push(`${prefix}${lines[index] ?? ''}`);
        }
      }

      if (mode === 'files_with_matches') {
        return {
          mode,
          filenames: applyLimit(fileMatches, limit, offset),
        };
      }
      if (mode === 'count') {
        return {
          mode,
          counts: applyLimit(countMatches, limit, offset),
        };
      }
      return {
        mode,
        lines: applyLimit(lineMatches, limit, offset),
      };
    },
  );

  return [Read, Write, Edit, Glob, Grep];
}

