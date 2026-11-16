import {
  copy,
  fill,
  formatAge,
  modelCatalogueFor,
  projectSettingsOfOrDefault,
  type CommandInput,
  type ImportableChat,
  type ProjectId,
  type ReadModel,
} from '@styx/core';
import { Button, Modal } from '@styx/ui';
import { useEffect, useState, type KeyboardEvent } from 'react';
import { command } from '../../state/commands';
import { useModel, useNow, useUi } from '../../state/hooks';
import { reconcileSessionSettings } from '../chat/session-controls';
import {
  autoBranchFor,
  defaultSessionSettings,
  defaultToggles,
  sessionSettingsFor,
  type SpawnForm,
} from './modals';
import s from './ImportChatModal.module.css';

export interface ImportChatModalProps {
  id: string;
  projectId: ProjectId;
}

const selectModel = (m: ReadModel) => m;
const keyOf = (c: Pick<ImportableChat, 'source' | 'id'>): string => `${c.source}:${c.id}`;

/** `Claude Code · 2h ago`: which CLI the chat is from and when it last moved. */
export const chatMeta = (chat: Pick<ImportableChat, 'source' | 'updatedAt'>, now: number): string => {
  const agent = copy.agentProducts[chat.source];
  const age = formatAge(chat.updatedAt, now);
  return age === 'now'
    ? fill(copy.importChat.updatedNow, { agent })
    : fill(copy.importChat.updated, { agent, age });
};

/**
 * `session.importChat` for one chat: a new lane on the project's base, with the same defaults New task would pick
 * for that agent (branch name, toggles, model, mode, effort).
 */
export const importPayload = (
  model: ReadModel,
  projectId: ProjectId,
  chat: Pick<ImportableChat, 'source' | 'id'>,
): CommandInput<'session.importChat'> => {
  const base: SpawnForm = {
    agent: chat.source,
    worktree: 'new',
    branch: autoBranchFor(model, projectId, chat.source),
    firstMessage: '',
    toggles: defaultToggles(model, projectId),
    ...defaultSessionSettings(model, projectId),
  };
  const form = reconcileSessionSettings(chat.source, base, modelCatalogueFor(model, chat.source));
  const settings = sessionSettingsFor(chat.source, form);
  return {
    projectId,
    source: chat.source,
    chatId: chat.id,
    worktree: {
      kind: 'new',
      base: projectSettingsOfOrDefault(model, projectId).baseBranch,
      branch: form.branch,
    },
    toggles: form.toggles,
    model: settings.model,
    permissionMode: settings.permissionMode,
    effort: settings.effort,
  };
};

/**
 * "Import a chat": the project's past Claude Code and Codex chats on this machine (newest first); the one picked
 * opens as a task on its own lane with its conversation as it was, and the agent resumes it (`session.importChat`).
 * Reached from New task.
 */
export function ImportChatModal({ id, projectId }: ImportChatModalProps) {
  const model = useModel(selectModel);
  const popOverlay = useUi((u) => u.popOverlay);
  const openSession = useUi((u) => u.openSession);
  const now = useNow();
  const [chats, setChats] = useState<ImportableChat[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void command('session.importableChats', { projectId }).then((r) => {
      if (cancelled) return;
      if (!r.ok) {
        setChats([]);
        setError(fill(copy.importChat.failed, { message: r.error.message }));
        return;
      }
      setChats(r.value.chats);
      setPicked(r.value.chats[0] ? keyOf(r.value.chats[0]) : null);
    });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const close = () => popOverlay(id);
  const chosen = chats?.find((c) => keyOf(c) === picked) ?? null;
  const importChosen = async () => {
    if (chosen === null || busy) return;
    setBusy(true);
    setError(null);
    const r = await command('session.importChat', importPayload(model, projectId, chosen));
    setBusy(false);
    if (!r.ok) {
      setError(r.error.message);
      return;
    }
    close();
    openSession(projectId, r.value.sessionId);
  };

  /** Arrow keys move the pick through the list (a radio group); Enter imports it. */
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!chats || chats.length === 0) return;
    const i = chats.findIndex((c) => keyOf(c) === picked);
    const step = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
    if (step !== 0) {
      e.preventDefault();
      const next = chats[Math.min(chats.length - 1, Math.max(0, i + step))];
      if (next) {
        setPicked(keyOf(next));
        e.currentTarget.querySelector<HTMLElement>(`[data-chat-key="${keyOf(next)}"]`)?.focus();
      }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      void importChosen();
    }
  };

  return (
    <Modal
      width={600}
      top={70}
      title={copy.importChat.title}
      onClose={close}
      initialFocus="first"
      footer={
        <>
          <Button size="footer" variant="ghost" onClick={close}>
            {copy.general.cancel}
          </Button>
          <Button
            size="footer"
            variant="primary"
            disabled={chosen === null || busy}
            onClick={() => void importChosen()}
          >
            {busy ? copy.importChat.importing : copy.importChat.import}
          </Button>
        </>
      }
    >
      <div className={s['root']} data-import-chat-modal="true">
        <p className={s['lead']}>{copy.importChat.lead}</p>
        {chats === null ? (
          <div className={s['note']} role="status">
            {copy.importChat.loading}
          </div>
        ) : null}
        {chats !== null && chats.length === 0 && error === null ? (
          <div className={s['note']} role="status">
            {copy.importChat.empty}
          </div>
        ) : null}
        {chats !== null && chats.length > 0 ? (
          <div
            className={s['list']}
            role="radiogroup"
            aria-label={copy.importChat.title}
            onKeyDown={onKeyDown}
          >
            {chats.map((c) => {
              const on = keyOf(c) === picked;
              return (
                <button
                  key={keyOf(c)}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  tabIndex={on || picked === null ? 0 : -1}
                  data-inv={on ? 'true' : undefined}
                  data-chat-key={keyOf(c)}
                  className={s['row']}
                  onClick={() => setPicked(keyOf(c))}
                  onDoubleClick={() => void importChosen()}
                >
                  <span className={s['title']}>{c.title}</span>
                  <span className={s['meta']}>{chatMeta(c, now)}</span>
                </button>
              );
            })}
          </div>
        ) : null}
        {error !== null ? (
          <div className={s['error']} role="alert">
            {error}
          </div>
        ) : null}
      </div>
    </Modal>
  );
}
