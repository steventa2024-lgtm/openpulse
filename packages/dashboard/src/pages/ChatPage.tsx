import type { JSX } from 'react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowUp,
  Brain,
  FileSearch,
  FolderSearch,
  Globe,
  MessageCircle,
  MoreHorizontal,
  PanelRight,
  PencilLine,
  Plus,
  RotateCcw,
  Search,
  Sparkles,
  Square,
  SquareTerminal,
} from 'lucide-react';
import { Pill, useToast } from '../components/ui.js';
import { useGateway, useGatewayEvent, useQuery } from '../gateway/provider.js';
import { useProject } from '../project/provider.js';
import { clockTime, relativeTime, sessionLabel, titleFrom } from '../format.js';
import { ChatWelcome } from './chat/ChatWelcome.js';
import { ContextPanel } from './chat/ContextPanel.js';
import type {
  AgentEventPayload,
  ChatEventPayload,
  ChatMessage,
  ContentPart,
  PendingApproval,
  SessionRow,
} from '../types.js';

interface HistoryResponse {
  sessionKey: string;
  sessionId: string;
  thinkingLevel: string;
  model: string;
  running: boolean;
  messages: ChatMessage[];
}

interface LiveTool {
  toolCallId: string;
  name: string;
  summary: string;
  args?: unknown;
  result?: string;
  isError?: boolean;
  durationMs?: number;
}

export function ChatPage(): JSX.Element {
  const { request, status, assistantName } = useGateway();
  const toast = useToast();
  const mainKey = status.hello?.snapshot.sessionDefaults.mainSessionKey ?? 'agent:main:main';

  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [sessionKey, setSessionKey] = useState(mainKey);
  const [history, setHistory] = useState<HistoryResponse>();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [liveText, setLiveText] = useState('');
  const [liveTools, setLiveTools] = useState<LiveTool[]>([]);
  const [running, setRunning] = useState(false);
  const [draft, setDraft] = useState('');
  const [approvals, setApprovals] = useState<PendingApproval[]>([]);
  const [models, setModels] = useState<{ ref: string; name: string }[]>([]);
  const [primaryModel, setPrimaryModel] = useState<string>();
  const [filter, setFilter] = useState('');
  // Open by default when there is room for it beside the chat; afterwards, whatever was chosen.
  const [showContext, setShowContext] = useState(() =>
    readFlag('openpulse.chat.context', window.matchMedia('(min-width: 1200px)').matches),
  );
  const { active: project } = useProject();
  const tools = useQuery<{ tools: { name: string }[] }>('tools.list');
  const logRef = useRef<HTMLDivElement>(null);
  const draftRef = useRef<HTMLTextAreaElement>(null);
  const caretToEnd = useRef(false);
  const unsent = useRef(new Set<string>());
  const stickToBottom = useRef(true);

  const loadSessions = useCallback(() => {
    request<{ sessions: SessionRow[] }>('sessions.list', { limit: 100 })
      .then((r) => setSessions(r.sessions))
      .catch(() => undefined);
  }, [request]);

  const loadHistory = useCallback(
    (key: string) => {
      request<HistoryResponse>('chat.history', { sessionKey: key, limit: 200 })
        .then((r) => {
          setHistory(r);
          setMessages(r.messages);
          setRunning(r.running);
          setLiveText('');
          setLiveTools([]);
          stickToBottom.current = true;
        })
        .catch((e: unknown) => toast((e as Error).message, 'err'));
    },
    [request, toast],
  );

  const loadApprovals = useCallback(() => {
    request<{ pending: PendingApproval[] }>('exec.approval.list')
      .then((r) => setApprovals(r.pending))
      .catch(() => undefined);
  }, [request]);

  useEffect(() => {
    if (status.state !== 'open') return;
    loadSessions();
    loadApprovals();
    request<{ primary: string; models: { ref: string; name: string }[] }>('models.list')
      .then((r) => {
        setModels(r.models);
        setPrimaryModel(r.primary);
      })
      .catch(() => undefined);
  }, [status.state, loadSessions, loadApprovals, request]);

  useEffect(() => {
    if (status.state !== 'open') return;
    // A conversation started here has no history yet; asking for it would create an empty
    // session on the gateway. It comes into being with its first message.
    if (unsent.current.has(sessionKey)) {
      setHistory(undefined);
      setMessages([]);
      setRunning(false);
      setLiveText('');
      setLiveTools([]);
      return;
    }
    loadHistory(sessionKey);
  }, [status.state, sessionKey, loadHistory]);

  useGatewayEvent('chat', (payload) => {
    const event = payload as ChatEventPayload;
    if (event.sessionKey !== sessionKey) return;
    const text = textOf(event.message?.content ?? []);
    if (event.state === 'delta') {
      setRunning(true);
      setLiveText(text);
      return;
    }
    if (event.state === 'error') {
      setLiveText('');
      setRunning(false);
      toast(event.errorMessage ?? 'the run failed', 'err');
      loadHistory(sessionKey);
      return;
    }
    // final / aborted
    setLiveText('');
    setLiveTools([]);
    setRunning(false);
    loadHistory(sessionKey);
    loadSessions();
  });

  useGatewayEvent('agent', (payload) => {
    const event = payload as AgentEventPayload;
    if (event.sessionKey !== sessionKey) return;
    if (event.stream === 'lifecycle') {
      if (event.data.phase === 'start') {
        setRunning(true);
        setLiveTools([]);
      }
      if (event.data.phase === 'end') setRunning(false);
      return;
    }
    if (event.stream !== 'tool') return;
    const data = event.data as {
      phase: string;
      toolCallId: string;
      name: string;
      summary: string;
      args?: unknown;
      result?: string;
      isError?: boolean;
      durationMs?: number;
    };
    setLiveTools((current) => {
      if (data.phase === 'start')
        return [
          ...current,
          { toolCallId: data.toolCallId, name: data.name, summary: data.summary, args: data.args },
        ];
      return current.map((t) =>
        t.toolCallId === data.toolCallId
          ? { ...t, result: data.result, isError: data.isError, durationMs: data.durationMs }
          : t,
      );
    });
  });

  useGatewayEvent(['exec.approval.requested', 'exec.approval.resolved'], () => loadApprovals());
  useGatewayEvent('sessions.changed', () => loadSessions());

  useEffect(() => {
    if (stickToBottom.current) logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [messages, liveText, liveTools, approvals]);

  const send = async () => {
    const text = draft.trim();
    if (!text) return;
    setDraft('');
    // A new conversation is named after its first message, like any chat app.
    const row = sessions.find((s) => s.key === sessionKey);
    if (sessionKey !== mainKey && !row?.label && messages.length === 0) {
      void request('sessions.patch', { key: sessionKey, label: titleFrom(text) })
        .then(loadSessions)
        .catch(() => undefined);
    }
    setMessages((current) => [
      ...current,
      { role: 'user', content: [{ type: 'text', text }], timestamp: Date.now() },
    ]);
    setRunning(true);
    stickToBottom.current = true;
    try {
      unsent.current.delete(sessionKey);
      await request('chat.send', { sessionKey, message: text });
    } catch (error) {
      setRunning(false);
      toast((error as Error).message, 'err');
    }
  };

  const stop = () =>
    void request('chat.abort', { sessionKey }).catch((e: unknown) =>
      toast((e as Error).message, 'err'),
    );

  const resolveApproval = (id: string, decision: string) =>
    void request('exec.approval.resolve', { id, decision }).catch((e: unknown) =>
      toast((e as Error).message, 'err'),
    );

  const newConversation = () => {
    const key = `agent:main:chat-${Date.now().toString(36)}`;
    unsent.current.add(key);
    setSessionKey(key);
    setDraft('');
    window.setTimeout(() => draftRef.current?.focus(), 0);
  };

  const prefill = (text: string) => {
    caretToEnd.current = true;
    setDraft((current) => (current.trim() ? `${current.trimEnd()}\n\n${text}` : text));
  };

  // After a prefill has rendered, put the caret at the end so typing continues the prompt.
  useLayoutEffect(() => {
    const box = draftRef.current;
    if (!caretToEnd.current || !box) return;
    caretToEnd.current = false;
    box.focus();
    box.setSelectionRange(box.value.length, box.value.length);
  }, [draft]);

  const reviewApproval = (id: string) => {
    const element = document.getElementById(`approval-${id}`);
    element?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    element?.classList.add('flash');
    window.setTimeout(() => element?.classList.remove('flash'), 1200);
  };

  const toggleContext = () =>
    setShowContext((current) => {
      writeFlag('openpulse.chat.context', !current);
      return !current;
    });

  const newSession = () =>
    void request('sessions.reset', { key: sessionKey })
      .then(() => {
        toast('Started a fresh session');
        loadHistory(sessionKey);
        loadSessions();
      })
      .catch((e: unknown) => toast((e as Error).message, 'err'));

  const setModel = (model: string) => {
    // Choosing a model or thinking level starts the conversation on the gateway.
    unsent.current.delete(sessionKey);
    void request('sessions.patch', { key: sessionKey, model: model || null })
      .then(() => loadHistory(sessionKey))
      .catch((e: unknown) => toast((e as Error).message, 'err'));
  };

  const setThinking = (level: string) => {
    // Choosing a model or thinking level starts the conversation on the gateway.
    unsent.current.delete(sessionKey);
    void request('sessions.patch', { key: sessionKey, thinkingLevel: level })
      .then(() => loadHistory(sessionKey))
      .catch((e: unknown) => toast((e as Error).message, 'err'));
  };

  const ordered = useMemo(() => {
    const rows = [...sessions];
    rows.sort((a, b) =>
      a.key === mainKey ? -1 : b.key === mainKey ? 1 : b.updatedAt - a.updatedAt,
    );
    if (!rows.some((r) => r.key === sessionKey)) {
      rows.unshift({
        key: sessionKey,
        sessionId: history?.sessionId ?? '',
        createdAt: 0,
        updatedAt: 0,
        chatType: 'main',
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        running: false,
      });
    }
    return rows;
  }, [sessions, sessionKey, mainKey, history?.sessionId]);

  const available = new Set((tools.data?.tools ?? []).map((t) => t.name));
  // Before a conversation has started it will use the configured default model.
  const currentModel = history?.model ?? primaryModel;
  const groups = groupByDay(
    ordered.filter((session) =>
      `${conversationTitle(session.key, session.label)} ${session.key}`
        .toLowerCase()
        .includes(filter.trim().toLowerCase()),
    ),
    mainKey,
  );

  return (
    <div className={`chat${showContext ? ' with-context' : ''}`}>
      <aside className="chat-sessions">
        <div className="chat-sessions-head">
          <h2>Conversations</h2>
          <button className="icon accent" onClick={newConversation} title="New conversation">
            <Plus aria-hidden />
          </button>
        </div>
        <label className="chat-search">
          <Search aria-hidden />
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Search conversations…"
          />
        </label>
        <div className="chat-session-list">
          {groups.map(([label, rows]) => (
            <div key={label}>
              <h4>{label}</h4>
              {rows.map((session) => (
                <button
                  key={session.key}
                  className="chat-session"
                  aria-current={session.key === sessionKey}
                  onClick={() => setSessionKey(session.key)}
                >
                  <MessageCircle aria-hidden />
                  <span>
                    {conversationTitle(session.key, session.label)}
                    <small>
                      {session.running ? '● running · ' : ''}
                      {session.updatedAt ? relativeTime(session.updatedAt) : 'not started'}
                    </small>
                  </span>
                </button>
              ))}
            </div>
          ))}
          {groups.length === 0 && <p className="empty">No conversations match.</p>}
        </div>
      </aside>

      <section className="chat-main">
        <header className="chat-head">
          <strong className="chat-title">
            {conversationTitle(sessionKey, sessions.find((s) => s.key === sessionKey)?.label)}
          </strong>
          {running ? <Pill tone="warn">Running</Pill> : <Pill tone="ok">Active</Pill>}
          <span className="spacer" style={{ flex: 1 }} />
          <label className="select-with-icon" title="Model for this conversation">
            <Sparkles aria-hidden />
            <select value={currentModel ?? ''} onChange={(e) => setModel(e.target.value)}>
              {currentModel && !models.some((m) => m.ref === currentModel) && (
                <option value={currentModel}>{currentModel}</option>
              )}
              {models.map((model) => (
                <option key={model.ref} value={model.ref}>
                  {model.name}
                </option>
              ))}
            </select>
          </label>
          <label className="select-with-icon" title="Thinking effort">
            <Brain aria-hidden />
            <select
              value={history?.thinkingLevel ?? 'off'}
              onChange={(e) => setThinking(e.target.value)}
            >
              {['off', 'low', 'medium', 'high'].map((level) => (
                <option key={level} value={level}>
                  think: {level}
                </option>
              ))}
            </select>
          </label>
          <button className="icon" onClick={newSession} title="Clear this conversation's history">
            <RotateCcw aria-hidden />
          </button>
          <button
            className="icon"
            onClick={toggleContext}
            aria-pressed={showContext}
            title={showContext ? 'Hide the context panel' : 'Show the context panel'}
          >
            <PanelRight aria-hidden />
          </button>
        </header>

        <div
          className="chat-log"
          ref={logRef}
          onScroll={(event) => {
            const element = event.currentTarget;
            stickToBottom.current =
              element.scrollHeight - element.scrollTop - element.clientHeight < 80;
          }}
        >
          {messages.length === 0 && !liveText && !running && (
            <ChatWelcome projectName={project?.name} onPick={prefill} />
          )}
          {messages.map((message, index) => (
            <Message
              key={message.id ?? `${message.timestamp}-${index}`}
              message={message}
              assistantName={assistantName}
            />
          ))}
          {liveTools.map((tool) => (
            <ToolCard
              key={tool.toolCallId}
              name={tool.name}
              summary={tool.summary}
              body={tool.result}
              isError={tool.isError}
              durationMs={tool.durationMs}
            />
          ))}
          {liveText && (
            <article className="msg assistant">
              <span className="who">{assistantName}</span>
              <div className="bubble">{liveText}</div>
            </article>
          )}
          {running && !liveText && <div className="thinking">thinking…</div>}
        </div>

        {approvals.map((approval) => (
          <div className="approval" id={`approval-${approval.id}`} key={approval.id}>
            <strong>Approval required</strong>{' '}
            <span className="faint">
              ({approval.request.risk.level}: {approval.request.risk.reason})
            </span>
            <code className="cmd">{approval.request.command}</code>
            <div className="row">
              <button
                className="btn primary"
                onClick={() => resolveApproval(approval.id, 'allow-once')}
              >
                Allow once
              </button>
              <button className="btn" onClick={() => resolveApproval(approval.id, 'allow-always')}>
                Always allow
              </button>
              <button className="btn danger" onClick={() => resolveApproval(approval.id, 'deny')}>
                Deny
              </button>
            </div>
          </div>
        ))}

        <div className="chat-capabilities">
          {CAPABILITIES.map((cap) => {
            const on = cap.tools.some((t) => available.has(t));
            return (
              <button
                key={cap.label}
                className="cap-chip"
                disabled={tools.data !== undefined && !on}
                title={
                  on || !tools.data
                    ? `Ask the agent to ${cap.label.toLowerCase()}`
                    : `${cap.label} is switched off by your permissions`
                }
                onClick={() => prefill(cap.prompt)}
              >
                <cap.icon aria-hidden />
                {cap.label}
              </button>
            );
          })}
          <a className="cap-chip" href="#/security" title="See and change what the agent may do">
            More <MoreHorizontal aria-hidden />
          </a>
        </div>

        <div className="composer">
          <textarea
            ref={draftRef}
            value={draft}
            placeholder="Message OpenPulse…"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                void send();
              }
            }}
            rows={Math.min(8, Math.max(1, draft.split('\n').length))}
          />
          <span className="composer-hint">↵ Send · Shift+↵ New line</span>
          {running ? (
            <button className="send-btn stop" onClick={stop} title="Stop">
              <Square aria-hidden />
            </button>
          ) : (
            <button
              className="send-btn"
              onClick={() => void send()}
              disabled={!draft.trim()}
              title="Send"
            >
              <ArrowUp aria-hidden />
            </button>
          )}
        </div>
      </section>

      {showContext && (
        <ContextPanel
          model={currentModel}
          approvals={approvals}
          sessionCount={sessions.length}
          onReviewApproval={reviewApproval}
        />
      )}
    </div>
  );
}

const CAPABILITIES = [
  {
    label: 'Read files',
    icon: FileSearch,
    tools: ['read'],
    prompt: 'Read the relevant files and tell me ',
  },
  {
    label: 'Edit code',
    icon: PencilLine,
    tools: ['edit', 'write', 'propose_change'],
    prompt: 'Make this change and propose it for my review: ',
  },
  { label: 'Run commands', icon: SquareTerminal, tools: ['exec'], prompt: 'Run the command that ' },
  {
    label: 'Browse web',
    icon: Globe,
    tools: ['browser', 'web_fetch'],
    prompt: 'Look this up on the web: ',
  },
  {
    label: 'Search project',
    icon: FolderSearch,
    tools: ['exec', 'read'],
    prompt: 'Search the project for ',
  },
];

/** "agent:main:chat-…" keys are conversations started here; name them until they have a label. */
function conversationTitle(key: string, label?: string): string {
  if (label) return label;
  if (/:chat-[a-z0-9]+$/.test(key)) return 'New conversation';
  return sessionLabel(key);
}

function groupByDay(rows: SessionRow[], mainKey: string): [string, SessionRow[]][] {
  const startOfToday = new Date().setHours(0, 0, 0, 0);
  const startOfYesterday = startOfToday - 86_400_000;
  const buckets = new Map<string, SessionRow[]>();
  for (const row of rows) {
    const label =
      row.key === mainKey
        ? 'Pinned'
        : !row.updatedAt || row.updatedAt >= startOfToday
          ? 'Today'
          : row.updatedAt >= startOfYesterday
            ? 'Yesterday'
            : 'Earlier';
    buckets.set(label, [...(buckets.get(label) ?? []), row]);
  }
  return ['Pinned', 'Today', 'Yesterday', 'Earlier']
    .filter((label) => buckets.has(label))
    .map((label) => [label, buckets.get(label)!]);
}

function readFlag(key: string, fallback: boolean): boolean {
  try {
    const value = localStorage.getItem(key);
    return value === null ? fallback : value === '1';
  } catch {
    return fallback;
  }
}

function writeFlag(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, value ? '1' : '0');
  } catch {
    // ignore
  }
}

function Message({
  message,
  assistantName,
}: {
  message: ChatMessage;
  assistantName: string;
}): JSX.Element | null {
  if (message.role === 'toolResult') {
    return (
      <ToolCard
        name={message.toolName ?? 'tool'}
        summary={message.toolName ?? 'tool'}
        body={textOf(message.content)}
        isError={message.isError}
        resultOnly
      />
    );
  }

  const text = textOf(message.content);
  const thinking = message.content.filter(
    (p): p is Extract<ContentPart, { type: 'thinking' }> => p.type === 'thinking',
  );
  const calls = message.content.filter(
    (p): p is Extract<ContentPart, { type: 'toolCall' }> => p.type === 'toolCall',
  );

  return (
    <>
      {thinking.map((part, index) => (
        <div className="thinking" key={`t-${index}`}>
          {part.thinking}
        </div>
      ))}
      {(text || message.role === 'user') && (
        <article className={`msg ${message.role}`}>
          <span className="who">
            {message.role === 'user' ? senderLabel(message) : assistantName}
            {message.injected ? ' · note' : ''} · {clockTime(message.timestamp)}
          </span>
          <div className="bubble">{text}</div>
        </article>
      )}
      {calls.map((call) => (
        <ToolCard
          key={call.id}
          name={call.name}
          summary={call.name}
          body={JSON.stringify(call.arguments, null, 2)}
        />
      ))}
    </>
  );
}

function ToolCard({
  name,
  summary,
  body,
  isError,
  durationMs,
  resultOnly,
}: {
  name: string;
  summary: string;
  body?: string;
  isError?: boolean;
  durationMs?: number;
  resultOnly?: boolean;
}): JSX.Element {
  return (
    <details className="tool-card">
      <summary>
        <span style={{ color: isError ? 'var(--err)' : 'var(--accent)' }}>
          {isError ? '✗' : resultOnly ? '↵' : '⚙'}
        </span>
        <span className="mono">{name}</span>
        <span className="faint">{summary !== name ? summary : ''}</span>
        {durationMs !== undefined && (
          <span className="faint" style={{ marginLeft: 'auto' }}>
            {durationMs} ms
          </span>
        )}
      </summary>
      <pre>{body ?? '(running…)'}</pre>
    </details>
  );
}

/** Messages typed here are "You"; anything arriving from a channel keeps its sender's name. */
function senderLabel(message: ChatMessage): string {
  if (!message.source || message.source === 'webchat') return 'You';
  return message.senderName ?? message.source;
}

function textOf(content: ContentPart[]): string {
  return content
    .filter((part): part is Extract<ContentPart, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('');
}
