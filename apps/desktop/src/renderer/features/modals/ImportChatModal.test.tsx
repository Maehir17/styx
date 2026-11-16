// @vitest-environment jsdom
import { copy, fill, fixtures } from '@styx/core';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useReadModel } from '../../state/read-model';
import { useUiStore } from '../../state/ui-store';
import { chatMeta, ImportChatModal, importPayload } from './ImportChatModal';

const { ids, DEMO_NOW } = fixtures;
const CLAUDE = {
  source: 'claude',
  id: '6f1c2d3e-aaaa-bbbb-cccc-000000000001',
  title: 'Fix the flaky order test',
  startedAt: DEMO_NOW - 7_200_000,
  updatedAt: DEMO_NOW - 7_200_000,
};
const CODEX = {
  source: 'codex',
  id: '0199aa00-1111-2222-3333-444455556666',
  title: 'Add input validation',
  startedAt: DEMO_NOW - 2 * 86_400_000,
  updatedAt: DEMO_NOW - 2 * 86_400_000,
};

let chats: unknown[] = [CLAUDE, CODEX];
let importOk = true;
const commandMock = vi.fn<(name: string, input?: unknown) => Promise<unknown>>(async (name) => {
  if (name === 'session.importableChats') return { ok: true as const, value: { chats } };
  if (name === 'session.importChat')
    return importOk
      ? { ok: true as const, value: { sessionId: 'sess-imported', worktreeId: 'wt-imported' } }
      : { ok: false as const, error: { code: 'not-found', message: copy.importChat.gone } };
  return { ok: true as const, value: {} };
});
const calls = (name: string) => commandMock.mock.calls.filter((c) => c[0] === name);

describe('ImportChatModal', () => {
  beforeEach(() => {
    commandMock.mockClear();
    chats = [CLAUDE, CODEX];
    importOk = true;
    Object.assign(window, { styx: { platform: 'darwin', env: { now: DEMO_NOW }, command: commandMock } });
    useReadModel.getState().replaceModel(fixtures.demoReadModel(), 'connected');
    useUiStore.setState({
      overlays: [{ id: 'modal-1', kind: 'modal', modal: 'import-chat', projectId: ids.project.acmeShop }],
      screen: 'workspace',
      platform: 'darwin',
      projectId: ids.project.acmeShop,
    });
  });
  afterEach(() => {
    cleanup();
    Object.assign(window, { styx: undefined });
  });

  it('lists the project’s chats newest first with where they came from, the newest picked', async () => {
    render(<ImportChatModal id="modal-1" projectId={ids.project.acmeShop} />);
    expect(screen.getByRole('status').textContent).toBe(copy.importChat.loading);
    await waitFor(() => expect(screen.getAllByRole('radio')).toHaveLength(2));
    expect(calls('session.importableChats').map((c) => c[1])).toEqual([{ projectId: ids.project.acmeShop }]);
    const rows = screen.getAllByRole('radio');
    expect(rows.map((r) => r.textContent)).toEqual([
      `${CLAUDE.title}${fill(copy.importChat.updated, { agent: copy.agentProducts.claude, age: '2h' })}`,
      `${CODEX.title}${fill(copy.importChat.updated, { agent: copy.agentProducts.codex, age: '2d' })}`,
    ]);
    expect(rows.map((r) => r.getAttribute('aria-checked'))).toEqual(['true', 'false']);
    expect(rows[0]?.getAttribute('data-inv')).toBe('true');
  });

  it('arrow keys move the pick; Import starts the task with New task’s defaults and opens it', async () => {
    render(<ImportChatModal id="modal-1" projectId={ids.project.acmeShop} />);
    await waitFor(() => expect(screen.getAllByRole('radio')).toHaveLength(2));
    fireEvent.keyDown(screen.getByRole('radiogroup'), { key: 'ArrowDown' });
    expect(screen.getAllByRole('radio').map((r) => r.getAttribute('aria-checked'))).toEqual([
      'false',
      'true',
    ]);
    expect(document.activeElement).toBe(screen.getAllByRole('radio')[1]);

    fireEvent.click(screen.getByRole('button', { name: copy.importChat.import }));
    await waitFor(() => expect(calls('session.importChat')).toHaveLength(1));
    const sent = calls('session.importChat')[0]?.[1];
    expect(sent).toEqual(
      importPayload(useReadModel.getState().model, ids.project.acmeShop, { source: 'codex', id: CODEX.id }),
    );
    expect(sent).toMatchObject({
      projectId: ids.project.acmeShop,
      source: 'codex',
      chatId: CODEX.id,
      worktree: { kind: 'new' },
    });
    await waitFor(() => expect(useUiStore.getState().overlays).toHaveLength(0));
  });

  it('says so when there are no chats, and shows why an import was refused', async () => {
    chats = [];
    const { unmount } = render(<ImportChatModal id="modal-1" projectId={ids.project.acmeShop} />);
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe(copy.importChat.empty));
    expect((screen.getByRole('button', { name: copy.importChat.import }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    unmount();

    chats = [CLAUDE];
    importOk = false;
    render(<ImportChatModal id="modal-1" projectId={ids.project.acmeShop} />);
    await waitFor(() => expect(screen.getAllByRole('radio')).toHaveLength(1));
    fireEvent.keyDown(screen.getByRole('radiogroup'), { key: 'Enter' });
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(copy.importChat.gone));
    // The window stays open (the app's error toast may show too).
    expect(useUiStore.getState().overlays.some((o) => o.kind === 'modal' && o.modal === 'import-chat')).toBe(
      true,
    );
  });

  it('meta reads “just now” for a chat that moved this minute', () => {
    expect(chatMeta({ source: 'claude', updatedAt: DEMO_NOW - 10_000 }, DEMO_NOW)).toBe(
      fill(copy.importChat.updatedNow, { agent: copy.agentProducts.claude }),
    );
  });
});
