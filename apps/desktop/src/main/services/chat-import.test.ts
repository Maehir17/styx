import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  claudeProjectKey,
  claudeSessionFile,
  claudeUserText,
  convertClaude,
  convertCodex,
  listImportableChats,
  patchFiles,
  placeClaudeSession,
  readImportableChat,
} from './chat-import';

const PROJECT = '/Users/me/code/acme-shop';
const T0 = Date.parse('2026-10-01T10:00:00.000Z');
const at = (s: number): string => new Date(T0 + s * 1000).toISOString();
const jsonl = (records: unknown[]): string => records.map((r) => JSON.stringify(r)).join('\n') + '\n';

const claudeChat = (cwd = PROJECT): string =>
  jsonl([
    { type: 'summary', summary: 'Fix the flaky order test', leafUuid: 'x' },
    {
      type: 'user',
      isMeta: true,
      cwd,
      timestamp: at(0),
      message: { role: 'user', content: 'Caveat: the messages below…' },
    },
    {
      type: 'user',
      cwd,
      sessionId: 's1',
      timestamp: at(1),
      message: { role: 'user', content: 'Fix the flaky order test' },
    },
    {
      type: 'assistant',
      cwd,
      timestamp: at(2),
      message: {
        id: 'm1',
        role: 'assistant',
        content: [{ type: 'thinking', thinking: 'Look at the test first.' }],
      },
    },
    {
      type: 'assistant',
      cwd,
      timestamp: at(3),
      message: {
        id: 'm1',
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'npx vitest run order' } }],
      },
    },
    {
      type: 'user',
      cwd,
      timestamp: at(4),
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tu1', is_error: true, content: 'Error: 1 failed' }],
      },
    },
    {
      type: 'assistant',
      cwd,
      timestamp: at(5),
      message: {
        id: 'm2',
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tu2', name: 'Edit', input: { file_path: `${cwd}/src/order.test.ts` } },
        ],
      },
    },
    {
      type: 'user',
      cwd,
      timestamp: at(6),
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu2', content: 'ok' }] },
    },
    {
      type: 'assistant',
      isSidechain: true,
      cwd,
      timestamp: at(7),
      message: { id: 'sub', role: 'assistant', content: [{ type: 'text', text: 'subagent' }] },
    },
    {
      type: 'assistant',
      cwd,
      timestamp: at(8),
      message: {
        id: 'm3',
        role: 'assistant',
        content: [{ type: 'text', text: 'Fixed: the test now waits for the order.' }],
      },
    },
    {
      type: 'user',
      cwd,
      timestamp: at(9),
      message: {
        role: 'user',
        content:
          '<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args>keep it short</command-args>',
      },
    },
    {
      type: 'user',
      cwd,
      timestamp: at(10),
      message: { role: 'user', content: '<local-command-stdout>Compacted</local-command-stdout>' },
    },
  ]);

const codexChat = (id: string, cwd = PROJECT): string =>
  jsonl([
    { timestamp: at(0), type: 'session_meta', payload: { id, cwd, cli_version: '0.163.0' } },
    {
      timestamp: at(1),
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: '<environment_context>\n  <cwd>x</cwd>\n</environment_context>' },
        ],
      },
    },
    {
      timestamp: at(2),
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'Add input validation to checkout' }],
      },
    },
    {
      timestamp: at(3),
      type: 'event_msg',
      payload: { type: 'user_message', message: 'Add input validation to checkout' },
    },
    {
      timestamp: at(4),
      type: 'response_item',
      payload: { type: 'reasoning', summary: [{ type: 'summary_text', text: 'Read the form first.' }] },
    },
    {
      timestamp: at(5),
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'shell',
        arguments: JSON.stringify({ command: ['bash', '-lc', 'rg -n checkout src'] }),
        call_id: 'c1',
      },
    },
    {
      timestamp: at(6),
      type: 'response_item',
      payload: {
        type: 'function_call_output',
        call_id: 'c1',
        output: JSON.stringify({ output: 'src/checkout.ts', metadata: { exit_code: 0 } }),
      },
    },
    {
      timestamp: at(7),
      type: 'response_item',
      payload: {
        type: 'custom_tool_call',
        name: 'apply_patch',
        call_id: 'c2',
        input: '*** Begin Patch\n*** Update File: src/checkout.ts\n@@\n-a\n+b\n*** End Patch',
      },
    },
    {
      timestamp: at(8),
      type: 'response_item',
      payload: {
        type: 'custom_tool_call_output',
        call_id: 'c2',
        output: 'Success. Updated the following files:\nM src/checkout.ts',
      },
    },
    {
      timestamp: at(9),
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'shell',
        arguments: JSON.stringify({ command: ['bash', '-lc', 'npm test'] }),
        call_id: 'c3',
      },
    },
    {
      timestamp: at(10),
      type: 'response_item',
      payload: {
        type: 'function_call_output',
        call_id: 'c3',
        output: JSON.stringify({ output: 'FAIL checkout.test.ts\nmore', metadata: { exit_code: 1 } }),
      },
    },
    {
      timestamp: at(11),
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Validation added.' }],
      },
    },
  ]);

describe('convertClaude', () => {
  it('turns a Claude Code session file into the same rows a live chat would have, with original times', () => {
    const rows = convertClaude(claudeChat(), PROJECT, 0);
    expect(rows.map((r) => [r.payload.kind, r.body])).toEqual([
      ['user', 'Fix the flaky order test'],
      ['thinking', 'Look at the test first.'],
      ['tool', 'Bash npx vitest run order'],
      ['tool', 'Edit src/order.test.ts'],
      ['file-list', 'src/order.test.ts'],
      ['agent', 'Fixed: the test now waits for the order.'],
      ['user', '/compact keep it short'],
    ]);
    expect(rows[0]?.createdAt).toBe(T0 + 1000);
    expect(rows[2]?.payload).toMatchObject({ kind: 'tool', status: 'error', detail: 'Error: 1 failed' });
    expect(rows[3]?.payload).toMatchObject({ kind: 'tool', status: 'ok', detail: null });
  });

  it('never leaves a tool running when the chat stopped before its result', () => {
    const rows = convertClaude(
      jsonl([
        {
          type: 'assistant',
          timestamp: at(0),
          message: {
            id: 'm',
            content: [{ type: 'tool_use', id: 't', name: 'Read', input: { file_path: 'a.ts' } }],
          },
        },
      ]),
      PROJECT,
      0,
    );
    expect(rows[0]?.payload).toMatchObject({ kind: 'tool', status: 'ok' });
  });

  it('keeps images as a note and drops CLI noise', () => {
    expect(
      claudeUserText({
        message: {
          content: [
            { type: 'text', text: 'look' },
            { type: 'image', source: {} },
          ],
        },
      }),
    ).toBe('look\n\n[1 image]');
    expect(claudeUserText({ message: { content: '[Request interrupted by user]' } })).toBeNull();
    expect(claudeUserText({ isCompactSummary: true, message: { content: 'summary' } })).toBeNull();
  });
});

describe('convertCodex', () => {
  it('turns a Codex rollout into rows: instructions dropped, shell as Bash, apply_patch as Edit with its files', () => {
    const rows = convertCodex(codexChat('0199aa00-1111-2222-3333-444455556666'), PROJECT, 0);
    expect(rows.map((r) => [r.payload.kind, r.body])).toEqual([
      ['user', 'Add input validation to checkout'],
      ['thinking', 'Read the form first.'],
      ['tool', 'Bash rg -n checkout src'],
      ['tool', 'Edit src/checkout.ts'],
      ['file-list', 'src/checkout.ts'],
      ['tool', 'Bash npm test'],
      ['agent', 'Validation added.'],
    ]);
    expect(rows[5]?.payload).toMatchObject({ status: 'error', detail: 'FAIL checkout.test.ts' });
    expect(rows[2]?.payload).toMatchObject({ status: 'ok', detail: null });
  });

  it('reads the files of a patch', () => {
    expect(patchFiles('*** Add File: a.ts\n*** Update File: b.ts\n*** Delete File: a.ts')).toEqual([
      'a.ts',
      'b.ts',
    ]);
  });
});

describe('listing and reading from disk', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'chat-import-'));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  const deps = (): { home: string; env: NodeJS.ProcessEnv; now: number } => ({
    home,
    env: {},
    now: T0 + 3_600_000,
  });
  const claudeDir = (cwd: string): string => join(home, '.claude', 'projects', claudeProjectKey(cwd));
  const codexDir = (): string => join(home, '.codex', 'sessions', '2026', '10', '01');

  it('lists this project’s chats from both CLIs, newest first, and skips other projects', async () => {
    mkdirSync(claudeDir(PROJECT), { recursive: true });
    writeFileSync(join(claudeDir(PROJECT), '6f1c2d3e-aaaa-bbbb-cccc-000000000001.jsonl'), claudeChat());
    // Same lossy directory name, different real cwd: not this project.
    writeFileSync(
      join(claudeDir(PROJECT), '6f1c2d3e-aaaa-bbbb-cccc-000000000002.jsonl'),
      claudeChat('/Users/me/code/acme.shop'),
    );
    mkdirSync(codexDir(), { recursive: true });
    const codexFile = join(codexDir(), 'rollout-2026-10-01T10-00-00-0199aa00.jsonl');
    writeFileSync(codexFile, codexChat('0199aa00-1111-2222-3333-444455556666'));
    writeFileSync(
      join(codexDir(), 'rollout-2026-10-01T09-00-00-other.jsonl'),
      codexChat('0199aa00-1111-2222-3333-777777777777', '/elsewhere'),
    );
    utimesSync(codexFile, new Date(T0 + 50_000), new Date(T0 + 50_000));

    const chats = await listImportableChats(deps(), PROJECT);
    expect(chats.map((c) => [c.source, c.id, c.title])).toEqual([
      ['claude', '6f1c2d3e-aaaa-bbbb-cccc-000000000001', 'Fix the flaky order test'],
      ['codex', '0199aa00-1111-2222-3333-444455556666', 'Add input validation to checkout'],
    ]);
    expect(chats[1]?.startedAt).toBe(T0);
  });

  it('reads a chat by its id only, and copies a Claude session where a resume from the worktree finds it', async () => {
    mkdirSync(claudeDir(PROJECT), { recursive: true });
    const id = '6f1c2d3e-aaaa-bbbb-cccc-000000000001';
    writeFileSync(join(claudeDir(PROJECT), `${id}.jsonl`), claudeChat());
    const worktree = '/Users/me/.styx/worktrees/acme-shop/agent-claude-1';

    expect(await readImportableChat(deps(), PROJECT, 'claude', 'not-listed-0000', worktree)).toBeNull();
    const read = await readImportableChat(deps(), PROJECT, 'claude', id, worktree);
    expect(read?.chat.rows[0]).toMatchObject({ body: 'Fix the flaky order test' });

    await placeClaudeSession(deps(), read?.file ?? '', worktree, id);
    const copied = claudeSessionFile(home, {}, worktree, id);
    expect(copied).toBe(
      join(home, '.claude', 'projects', '-Users-me--styx-worktrees-acme-shop-agent-claude-1', `${id}.jsonl`),
    );
    expect(readFileSync(copied, 'utf8')).toBe(claudeChat());
  });

  it('honours CLAUDE_CONFIG_DIR and CODEX_HOME', async () => {
    const env = { CLAUDE_CONFIG_DIR: join(home, 'cc'), CODEX_HOME: join(home, 'cx') };
    mkdirSync(join(home, 'cc', 'projects', claudeProjectKey(PROJECT)), { recursive: true });
    writeFileSync(
      join(home, 'cc', 'projects', claudeProjectKey(PROJECT), '6f1c2d3e-aaaa-bbbb-cccc-000000000009.jsonl'),
      claudeChat(),
    );
    const chats = await listImportableChats({ home, env, now: T0 }, PROJECT);
    expect(chats.map((c) => c.id)).toEqual(['6f1c2d3e-aaaa-bbbb-cccc-000000000009']);
  });
});
