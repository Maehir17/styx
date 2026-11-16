import { copyFile, mkdir, readFile, stat } from 'node:fs/promises';
import { basename, join, normalize } from 'node:path';
import type { MessagePayload } from '@styx/core';
import {
  agentHistoryFs,
  claudeProjectsDir,
  codexSessionsDir,
  cwdFromHead,
  type AgentHistoryFs,
} from './agent-history';
import { StreamParser, relPath, toolHint } from './stream-runner';

/**
 * Bringing a chat started outside Styx into a task: the conversations Claude Code and Codex keep on disk
 * (`~/.claude/projects/<key>/<id>.jsonl`, `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`) are listed per project and
 * one is converted into transcript rows, so the chat reads as it did; the task then resumes the CLI's own session by
 * its id, so the agent remembers it. Claude Code records go through the live `StreamParser`, so imported rows look
 * exactly like live ones.
 */

export type ImportSource = 'claude' | 'codex';

export interface ImportableChat {
  source: ImportSource;
  /** The CLI's own session id (Claude Code: the file name; Codex: `session_meta.payload.id`). */
  id: string;
  /** The first thing the person typed, one line. */
  title: string;
  startedAt: number;
  updatedAt: number;
  /** Where it lives; never sent to the renderer. */
  file: string;
}

export interface ImportedRow {
  body: string;
  payload: MessagePayload;
  createdAt: number;
}

export interface ImportedChat {
  source: ImportSource;
  id: string;
  rows: ImportedRow[];
}

export interface ChatImportDeps {
  home: string;
  env: NodeJS.ProcessEnv;
  fs?: AgentHistoryFs;
  now: number;
}

/** Chats listed per CLI, newest first. */
export const IMPORT_LIST_MAX = 40;
/** Files looked at per CLI while listing. */
const IMPORT_SCAN_MAX = 400;
/** First bytes read while listing: enough for the cwd and, nearly always, the first prompt. */
const LIST_HEAD_BYTES = 65_536;
/** Files larger than this are not imported (a pasted-image-heavy chat can run to hundreds of MB). */
export const IMPORT_MAX_BYTES = 64 * 1024 * 1024;
const TITLE_MAX = 120;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{5,127}$/;

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Json) : null;
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

const oneLine = (s: string, max = TITLE_MAX): string => {
  const line = s.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

const parseJsonLines = (text: string): Json[] => {
  const out: Json[] = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (t === '') continue;
    try {
      const v = obj(JSON.parse(t));
      if (v) out.push(v);
    } catch {
      /* a line cut by a partial read, or not JSON */
    }
  }
  return out;
};

const timeOf = (rec: Json, fallback: number): number => {
  const t = str(rec['timestamp']);
  const ms = t === null ? Number.NaN : Date.parse(t);
  return Number.isFinite(ms) ? ms : fallback;
};

const samePath = (a: string, b: string): boolean =>
  normalize(a).replace(/[\\/]+$/, '') === normalize(b).replace(/[\\/]+$/, '');

// --- Claude Code ---------------------------------------------------------------------------------------------------

/** Claude Code's directory name for a working directory: every character outside [A-Za-z0-9] becomes `-`. */
export const claudeProjectKey = (cwd: string): string => cwd.replace(/[^A-Za-z0-9]/g, '-');

/** Where Claude Code looks for a session's file when it is resumed from `cwd`. */
export const claudeSessionFile = (home: string, env: NodeJS.ProcessEnv, cwd: string, id: string): string =>
  join(claudeProjectsDir(home, env), claudeProjectKey(cwd), `${id}.jsonl`);

/** Text the CLI writes into the user's turn on its own (slash-command wrappers, caveats, interrupts). */
const CLAUDE_NOISE =
  /^(<local-command-|<command-message>|<bash-(input|stdout|stderr)>|Caveat: |\[Request interrupted)/;

/** The person's own words in a Claude Code `user` record, or null when the record is a tool result or CLI noise. */
export const claudeUserText = (rec: Json): string | null => {
  if (rec['isMeta'] === true || rec['isCompactSummary'] === true || rec['isSidechain'] === true) return null;
  const message = obj(rec['message']);
  const content = message ? message['content'] : null;
  let text: string;
  let images = 0;
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      const b = obj(block);
      if (!b) continue;
      if (b['type'] === 'tool_result') return null;
      if (b['type'] === 'text') parts.push(str(b['text']) ?? '');
      if (b['type'] === 'image') images++;
    }
    text = parts.join('\n\n');
  } else return null;
  // A slash command reads as the person typed it.
  const command = /<command-name>([^<]*)<\/command-name>/.exec(text);
  if (command) {
    const args = /<command-args>([^<]*)<\/command-args>/.exec(text)?.[1]?.trim() ?? '';
    return `${command[1]?.trim() ?? ''}${args ? ` ${args}` : ''}`.trim() || null;
  }
  const trimmed = text.trim();
  if (trimmed !== '' && CLAUDE_NOISE.test(trimmed)) return null;
  if (trimmed === '' && images === 0) return null;
  const imageNote = images > 0 ? `[${images} image${images === 1 ? '' : 's'}]` : '';
  return [trimmed, imageNote].filter((s) => s !== '').join('\n\n');
};

/** Rows for one Claude Code session file, in order, with their original times. */
export const convertClaude = (text: string, worktreePath: string, fallbackTime: number): ImportedRow[] => {
  const parser = new StreamParser(worktreePath, { agent: 'claude' });
  const rows: ImportedRow[] = [];
  const toolRows = new Map<string, number>();
  for (const rec of parseJsonLines(text)) {
    if (rec['isSidechain'] === true) continue;
    const type = rec['type'];
    if (type !== 'user' && type !== 'assistant') continue;
    const at = timeOf(rec, fallbackTime);
    if (type === 'user') {
      const words = claudeUserText(rec);
      if (words !== null) {
        rows.push({ body: words, payload: { kind: 'user' }, createdAt: at });
        continue;
      }
    }
    if (rec['isMeta'] === true || rec['isCompactSummary'] === true) continue;
    for (const effect of parser.parseEvent(rec)) {
      if (effect.type === 'transcript') {
        rows.push({ body: effect.body, payload: effect.payload, createdAt: at });
        if (effect.payload.kind === 'tool' && effect.payload.toolUseId !== null)
          toolRows.set(effect.payload.toolUseId, rows.length - 1);
      } else if (effect.type === 'toolResult') {
        const i = toolRows.get(effect.toolUseId);
        const row = i === undefined ? undefined : rows[i];
        if (row && row.payload.kind === 'tool')
          row.payload = { ...row.payload, status: effect.ok ? 'ok' : 'error', detail: effect.detail };
      }
    }
  }
  // A tool whose result never arrived (the chat was cut off mid-turn) is not still running.
  for (const row of rows)
    if (row.payload.kind === 'tool' && row.payload.status === 'running')
      row.payload = { ...row.payload, status: 'ok' };
  return rows;
};

const claudeTitle = (records: Json[]): string | null => {
  for (const rec of records) {
    if (rec['type'] === 'summary' && str(rec['summary'])) return oneLine(str(rec['summary']) ?? '');
  }
  for (const rec of records) {
    if (rec['type'] !== 'user') continue;
    const words = claudeUserText(rec);
    if (words !== null) return oneLine(words);
  }
  return null;
};

async function listClaude(deps: ChatImportDeps, projectPath: string): Promise<ImportableChat[]> {
  const fs = deps.fs ?? agentHistoryFs();
  const dir = join(claudeProjectsDir(deps.home, deps.env), claudeProjectKey(projectPath));
  const entries = (await fs.readDir(dir)).filter(
    (e) =>
      (e.kind === 'file' || e.kind === 'symlink') &&
      e.name.endsWith('.jsonl') &&
      !e.name.startsWith('agent-'),
  );
  const stated: { file: string; id: string; mtimeMs: number }[] = [];
  for (const e of entries.slice(0, IMPORT_SCAN_MAX)) {
    const id = e.name.slice(0, -'.jsonl'.length);
    if (!SESSION_ID.test(id)) continue;
    const file = join(dir, e.name);
    const s = await fs.stat(file);
    if (s && !s.isDirectory) stated.push({ file, id, mtimeMs: s.mtimeMs });
  }
  stated.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const out: ImportableChat[] = [];
  for (const f of stated) {
    if (out.length >= IMPORT_LIST_MAX) break;
    const head = await fs.readHead(f.file, LIST_HEAD_BYTES);
    // The directory name is lossy (`/` and `.` both become `-`): the records' own cwd decides.
    const cwd = cwdFromHead(head);
    if (cwd !== null && !samePath(cwd, projectPath)) continue;
    const records = parseJsonLines(head);
    const title = claudeTitle(records);
    if (title === null) continue; // nothing the person said (an empty or hook-only session)
    const first = records.find((r) => str(r['timestamp']) !== null);
    out.push({
      source: 'claude',
      id: f.id,
      title,
      startedAt: first ? timeOf(first, f.mtimeMs) : f.mtimeMs,
      updatedAt: f.mtimeMs,
      file: f.file,
    });
  }
  return out;
}

// --- Codex -----------------------------------------------------------------------------------------------------------

/** Text Codex adds to the conversation on its own (instructions, environment, AGENTS.md). */
const CODEX_NOISE =
  /^(<environment_context>|<user_instructions>|<permissions instructions>|# AGENTS\.md instructions)/;

const codexText = (content: unknown, kinds: readonly string[]): string => {
  if (!Array.isArray(content)) return '';
  return content
    .map((b) => obj(b))
    .filter((b): b is Json => b !== null && kinds.includes(str(b['type']) ?? ''))
    .map((b) => str(b['text']) ?? '')
    .join('\n\n')
    .trim();
};

const codexUserText = (payload: Json): string | null => {
  if (payload['type'] !== 'message' || payload['role'] !== 'user') return null;
  const text = codexText(payload['content'], ['input_text']);
  if (text === '' || CODEX_NOISE.test(text)) return null;
  return text;
};

const parseArgs = (raw: unknown): Json => {
  if (obj(raw)) return obj(raw) ?? {};
  if (typeof raw !== 'string') return {};
  try {
    return obj(JSON.parse(raw)) ?? {};
  } catch {
    return {};
  }
};

const commandOf = (v: unknown): string => {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) {
    const parts = v.filter((p): p is string => typeof p === 'string');
    // `["bash", "-lc", "<script>"]` reads as the script.
    if (parts.length === 3 && /(^|\/)(ba|z)?sh$/.test(parts[0] ?? '') && parts[1] === '-lc')
      return parts[2] ?? '';
    return parts.join(' ');
  }
  return '';
};

/** Files named in an `apply_patch` body (`*** Add|Update|Delete File: <path>`). */
export const patchFiles = (patch: string): string[] => [
  ...new Set(
    [...patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map((m) => (m[1] ?? '').trim()),
  ),
];

/** A Codex tool call as Styx names it (shell → Bash, apply_patch → Edit), with its hint and the files it edits. */
const codexTool = (
  worktreePath: string,
  name: string,
  args: Json,
  rawInput: string,
): { tool: string; hint: string; files: string[] } => {
  if (name === 'shell' || name === 'exec_command' || name === 'local_shell' || name === 'container.exec') {
    const command = commandOf(args['command'] ?? args['cmd']);
    const hint = toolHint(worktreePath, 'Bash', { command });
    const patched = /apply_patch/.test(command) ? patchFiles(command) : [];
    return patched.length > 0
      ? { tool: 'Edit', hint: relPath(worktreePath, patched[0] ?? ''), files: patched }
      : { tool: 'Bash', hint, files: [] };
  }
  if (name === 'apply_patch') {
    const files = patchFiles(str(args['input']) ?? rawInput);
    return { tool: 'Edit', hint: files[0] ? relPath(worktreePath, files[0]) : '', files };
  }
  return { tool: name, hint: toolHint(worktreePath, name, args), files: [] };
};

/** `function_call_output.output`: a string, or JSON `{ output, metadata: { exit_code } }`. */
const codexOutcome = (raw: unknown): { ok: boolean; detail: string | null } => {
  const text = typeof raw === 'string' ? raw : JSON.stringify(raw ?? '');
  const parsed = parseArgs(text);
  const meta = obj(parsed['metadata']);
  const exit = meta ? meta['exit_code'] : undefined;
  const ok =
    typeof exit === 'number'
      ? exit === 0
      : !/^(error|failed|apply_patch verification failed)/i.test(text.trim());
  if (ok) return { ok, detail: null };
  const body = str(parsed['output']) ?? text;
  const line = body.split('\n').find((l) => l.trim() !== '') ?? '';
  return { ok, detail: line ? oneLine(line, 160) : null };
};

/** Rows for one Codex rollout file, in order, with their original times. */
export const convertCodex = (text: string, worktreePath: string, fallbackTime: number): ImportedRow[] => {
  const rows: ImportedRow[] = [];
  const calls = new Map<string, number>();
  for (const rec of parseJsonLines(text)) {
    if (rec['type'] !== 'response_item') continue;
    const p = obj(rec['payload']);
    if (!p) continue;
    const at = timeOf(rec, fallbackTime);
    const type = str(p['type']);
    if (type === 'message') {
      const user = codexUserText(p);
      if (user !== null) rows.push({ body: user, payload: { kind: 'user' }, createdAt: at });
      else if (p['role'] === 'assistant') {
        const said = codexText(p['content'], ['output_text']);
        if (said !== '') rows.push({ body: said, payload: { kind: 'agent' }, createdAt: at });
      }
    } else if (type === 'reasoning') {
      const thought = codexText(p['summary'], ['summary_text']);
      if (thought !== '')
        rows.push({
          body: thought,
          payload: { kind: 'thinking', status: 'done', durationMs: null },
          createdAt: at,
        });
    } else if (type === 'function_call' || type === 'custom_tool_call' || type === 'local_shell_call') {
      const name = type === 'local_shell_call' ? 'local_shell' : (str(p['name']) ?? 'tool');
      const rawInput = str(p['input']) ?? '';
      const args =
        type === 'local_shell_call'
          ? (obj(p['action']) ?? {})
          : type === 'custom_tool_call'
            ? { input: rawInput }
            : parseArgs(p['arguments']);
      const { tool, hint, files } = codexTool(worktreePath, name, args, rawInput);
      const callId = str(p['call_id']) ?? str(p['id']);
      rows.push({
        body: `${tool}${hint ? ` ${hint}` : ''}`,
        payload: { kind: 'tool', tool, hint, toolUseId: callId, status: 'ok', detail: null },
        createdAt: at,
      });
      if (callId !== null) calls.set(callId, rows.length - 1);
      if (files.length > 0) {
        const entries = files.map((f) => ({ path: relPath(worktreePath, f), added: 0, removed: 0 }));
        rows.push({
          body: entries.map((e) => e.path).join(', '),
          payload: { kind: 'file-list', files: entries },
          createdAt: at,
        });
      }
    } else if (type === 'function_call_output' || type === 'custom_tool_call_output') {
      const i = calls.get(str(p['call_id']) ?? '');
      const row = i === undefined ? undefined : rows[i];
      if (row && row.payload.kind === 'tool') {
        const { ok, detail } = codexOutcome(p['output']);
        row.payload = { ...row.payload, status: ok ? 'ok' : 'error', detail };
      }
    }
  }
  return rows;
};

const codexMeta = (records: Json[]): { id: string; cwd: string } | null => {
  for (const rec of records) {
    if (rec['type'] !== 'session_meta') continue;
    const p = obj(rec['payload']);
    const id = str(p?.['id']);
    const cwd = str(p?.['cwd']);
    if (id && cwd) return { id, cwd };
  }
  return null;
};

async function listCodex(deps: ChatImportDeps, projectPath: string): Promise<ImportableChat[]> {
  const fs = deps.fs ?? agentHistoryFs();
  const root = codexSessionsDir(deps.home, deps.env);
  const names = async (dir: string, kind: 'dir' | 'file'): Promise<string[]> =>
    (await fs.readDir(dir))
      .filter((e) => e.kind === kind || e.kind === 'symlink')
      .map((e) => e.name)
      .sort()
      .reverse();
  const files: string[] = [];
  outer: for (const y of await names(root, 'dir'))
    for (const m of await names(join(root, y), 'dir'))
      for (const d of await names(join(root, y, m), 'dir'))
        for (const f of await names(join(root, y, m, d), 'file')) {
          if (!/^rollout-.*\.jsonl$/.test(f)) continue;
          files.push(join(root, y, m, d, f));
          if (files.length >= IMPORT_SCAN_MAX) break outer;
        }
  const out: ImportableChat[] = [];
  for (const file of files) {
    if (out.length >= IMPORT_LIST_MAX) break;
    const records = parseJsonLines(await fs.readHead(file, LIST_HEAD_BYTES));
    const meta = codexMeta(records);
    if (meta === null || !samePath(meta.cwd, projectPath) || !SESSION_ID.test(meta.id)) continue;
    let title: string | null = null;
    for (const rec of records) {
      const p = rec['type'] === 'response_item' ? obj(rec['payload']) : null;
      const words = p ? codexUserText(p) : null;
      if (words !== null) {
        title = oneLine(words);
        break;
      }
    }
    const s = await fs.stat(file);
    const first = records.find((r) => str(r['timestamp']) !== null);
    const updatedAt = s?.mtimeMs ?? deps.now;
    out.push({
      source: 'codex',
      id: meta.id,
      title: title ?? oneLine(basename(file, '.jsonl')),
      startedAt: first ? timeOf(first, updatedAt) : updatedAt,
      updatedAt,
      file,
    });
  }
  return out;
}

// --- Public ----------------------------------------------------------------------------------------------------------

/** A project's past Claude Code and Codex chats, newest first. */
export async function listImportableChats(
  deps: ChatImportDeps,
  projectPath: string,
): Promise<ImportableChat[]> {
  const [claude, codex] = await Promise.all([listClaude(deps, projectPath), listCodex(deps, projectPath)]);
  return [...claude, ...codex].sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Reads one listed chat and converts it; the file is looked up again by id, never taken from the caller. */
export async function readImportableChat(
  deps: ChatImportDeps,
  projectPath: string,
  source: ImportSource,
  id: string,
  worktreePath: string,
): Promise<{ chat: ImportedChat; file: string } | null> {
  const listed = (await listImportableChats(deps, projectPath)).find(
    (c) => c.source === source && c.id === id,
  );
  if (!listed) return null;
  const size = (await stat(listed.file).catch(() => null))?.size ?? 0;
  if (size > IMPORT_MAX_BYTES) throw new Error('chat-too-large');
  const text = await readFile(listed.file, 'utf8');
  const rows =
    source === 'claude'
      ? convertClaude(text, worktreePath, listed.startedAt)
      : convertCodex(text, worktreePath, listed.startedAt);
  return { chat: { source, id, rows }, file: listed.file };
}

/**
 * Claude Code finds a session to resume only under the directory it is resumed from; a task runs in its own
 * worktree, so the session file is copied there first (the original stays where it was).
 */
export async function placeClaudeSession(
  deps: ChatImportDeps,
  file: string,
  worktreePath: string,
  id: string,
): Promise<void> {
  const target = claudeSessionFile(deps.home, deps.env, worktreePath, id);
  if (samePath(target, file)) return;
  await mkdir(join(target, '..'), { recursive: true });
  await copyFile(file, target);
}
