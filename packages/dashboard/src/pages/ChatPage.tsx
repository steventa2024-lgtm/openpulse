import type { JSX } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pill, useToast } from '../components/ui.js';
import { useGateway, useGatewayEvent } from '../gateway/provider.js';
import { clockTime, relativeTime, sessionLabel } from '../format.js';
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
  const logRef = useRef<HTMLDivElement>(null);
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
    request<{ models: { ref: string; name: string }[] }>('models.list')
      .then((r) => setModels(r.models))
      .catch(() => undefined);
  }, [status.state, loadSessions, loadApprovals, request]);

  useEffect(() => {
    if (status.state === 'open') loadHistory(sessionKey);
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
    setMessages((current) => [
      ...current,
      { role: 'user', content: [{ type: 'text', text }], timestamp: Date.now() },
    ]);
    setRunning(true);
    stickToBottom.current = true;
    try {
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

  const newSession = () =>
    void request('sessions.reset', { key: sessionKey })
      .then(() => {
        toast('Started a fresh session');
        loadHistory(sessionKey);
        loadSessions();
      })
      .catch((e: unknown) => toast((e as Error).message, 'err'));

  const setModel = (model: string) =>
    void request('sessions.patch', { key: sessionKey, model: model || null })
      .then(() => loadHistory(sessionKey))
      .catch((e: unknown) => toast((e as Error).message, 'err'));

  const setThinking = (level: string) =>
    void request('sessions.patch', { key: sessionKey, thinkingLevel: level })
      .then(() => loadHistory(sessionKey))
      .catch((e: unknown) => toast((e as Error).message, 'err'));

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

  return (
    <div className="chat">
      <aside className="chat-sessions">
        {ordered.map((session) => (
          <button
            key={session.key}
            className="chat-session"
            aria-current={session.key === sessionKey}
            onClick={() => setSessionKey(session.key)}
          >
            {sessionLabel(session.key, session.label)}
            <small>
              {session.running ? '● running · ' : ''}
              {relativeTime(session.updatedAt)}
            </small>
          </button>
        ))}
      </aside>

      <section className="chat-main">
        <header className="chat-head">
          <strong>{sessionLabel(sessionKey)}</strong>
          {running ? <Pill tone="warn">running</Pill> : <Pill tone="idle">idle</Pill>}
          <span className="spacer" style={{ flex: 1 }} />
          <select
            value={history?.model ?? ''}
            onChange={(e) => setModel(e.target.value)}
            style={{ width: 'auto' }}
            title="Model for this session"
          >
            {models.map((model) => (
              <option key={model.ref} value={model.ref}>
                {model.name}
              </option>
            ))}
          </select>
          <select
            value={history?.thinkingLevel ?? 'off'}
            onChange={(e) => setThinking(e.target.value)}
            style={{ width: 'auto' }}
            title="Thinking effort"
          >
            {['off', 'low', 'medium', 'high'].map((level) => (
              <option key={level} value={level}>
                think: {level}
              </option>
            ))}
          </select>
          <button
            className="btn ghost"
            onClick={newSession}
            title="Reset this session's transcript"
          >
            New
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
          {messages.length === 0 && !liveText && (
            <div className="empty">
              Say hello to {assistantName}. It can run commands, read and write files, browse the
              web and message you back on your channels.
            </div>
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
          <div className="approval" key={approval.id}>
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

        <div className="composer">
          <textarea
            value={draft}
            placeholder="Message the agent…   (Enter to send, Shift+Enter for a new line, /help for commands)"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                void send();
              }
            }}
            rows={1}
          />
          {running ? (
            <button className="btn danger" onClick={stop}>
              Stop
            </button>
          ) : (
            <button className="btn primary" onClick={() => void send()} disabled={!draft.trim()}>
              Send
            </button>
          )}
        </div>
      </section>
    </div>
  );
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
