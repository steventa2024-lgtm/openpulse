import type { JSX } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Editor, { type OnMount } from '@monaco-editor/react';
import '../editor/monaco.js';
import { languageFor, monaco as monacoApi } from '../editor/monaco.js';
import { useToast } from '../components/ui.js';
import { useGateway, useGatewayEvent } from '../gateway/provider.js';
import { useProject } from '../project/provider.js';
import type { ChatEventPayload } from '../types.js';
import { NoProject } from './NoProject.js';

interface TreeEntry {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size: number;
  collapsed?: boolean;
}

interface OpenFile {
  path: string;
  /** Contents as last read from or written to disk. */
  saved: string;
  /** Contents in the editor. */
  current: string;
  hash: string;
  /** The file changed on disk while there were unsaved edits. */
  conflict?: boolean;
}

interface Preferences {
  fontSize: number;
  wordWrap: boolean;
  minimap: boolean;
  readOnly: boolean;
}

const PREFS_KEY = 'openpulse.editor.prefs';

function loadPrefs(): Preferences {
  try {
    const stored = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Partial<Preferences>;
    return {
      fontSize: 13,
      wordWrap: false,
      minimap: true,
      readOnly: false,
      ...stored,
    };
  } catch {
    return { fontSize: 13, wordWrap: false, minimap: true, readOnly: false };
  }
}

const AI_ACTIONS: { id: string; label: string; changesFiles: boolean; prompt: string }[] = [
  {
    id: 'explain',
    label: 'Explain',
    changesFiles: false,
    prompt:
      'Explain what this code does, how it fits into the file, and anything surprising about it.',
  },
  {
    id: 'refactor',
    label: 'Refactor',
    changesFiles: true,
    prompt: 'Refactor this code for clarity without changing its behaviour.',
  },
  {
    id: 'fix',
    label: 'Fix errors',
    changesFiles: true,
    prompt: 'Find and fix the bugs or errors in this code.',
  },
  {
    id: 'docs',
    label: 'Add docs',
    changesFiles: true,
    prompt: 'Add concise documentation comments to this code where they help a reader.',
  },
  {
    id: 'tests',
    label: 'Generate tests',
    changesFiles: true,
    prompt:
      'Write tests for this code using the project’s existing test framework and conventions. Put them where the project keeps its tests.',
  },
  {
    id: 'improve',
    label: 'Suggest improvements',
    changesFiles: false,
    prompt:
      'Suggest concrete improvements to this code — performance, readability, edge cases. Do not change anything.',
  },
];

export function EditorPage(): JSX.Element {
  const { active } = useProject();
  if (!active) return <NoProject title="Editor" />;
  return <ProjectEditor key={active.id} projectId={active.id} projectName={active.name} />;
}

function ProjectEditor({
  projectId,
  projectName,
}: {
  projectId: string;
  projectName: string;
}): JSX.Element {
  const { request } = useGateway();
  const toast = useToast();
  const [tree, setTree] = useState<Record<string, TreeEntry[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set(['.']));
  const [files, setFiles] = useState<OpenFile[]>([]);
  const [activePath, setActivePath] = useState<string>();
  const [prefs, setPrefs] = useState<Preferences>(loadPrefs);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchHits, setSearchHits] = useState<{ path: string; line: number; text: string }[]>();
  const [assistant, setAssistant] = useState<{
    action: string;
    text: string;
    running: boolean;
    sessionKey: string;
  }>();
  const editorRef = useRef<monacoApi.editor.IStandaloneCodeEditor | undefined>(undefined);

  const activeFile = files.find((f) => f.path === activePath);
  // Event handlers read the latest open files through this ref rather than a stale closure.
  const filesRef = useRef(files);
  filesRef.current = files;
  /** Hashes this window just wrote, so the gateway's echo of our own save is not a "conflict". */
  const ownWrites = useRef(new Map<string, string>());
  const editorSession = `agent:main:editor:${projectId}`;

  useEffect(() => {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch {
      // ignore
    }
  }, [prefs]);

  // ---- tree ------------------------------------------------------------------------------------

  const loadDir = useCallback(
    async (dir: string) => {
      const result = await request<{ entries: TreeEntry[] }>('workspace.tree', { dir, depth: 1 });
      setTree((current) => ({ ...current, [dir]: result.entries }));
    },
    [request],
  );

  useEffect(() => {
    void loadDir('.').catch((e: unknown) => toast((e as Error).message, 'err'));
  }, [loadDir, toast]);

  const toggleDir = (dir: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(dir)) next.delete(dir);
      else {
        next.add(dir);
        if (!tree[dir]) void loadDir(dir).catch((e: unknown) => toast((e as Error).message, 'err'));
      }
      return next;
    });
  };

  const refreshTree = useCallback(() => {
    for (const dir of expanded) void loadDir(dir).catch(() => undefined);
  }, [expanded, loadDir]);

  // ---- files -----------------------------------------------------------------------------------

  const openFile = useCallback(
    async (path: string, line?: number) => {
      const existing = files.find((f) => f.path === path);
      if (!existing) {
        try {
          const file = await request<{ path: string; content: string; hash: string }>(
            'workspace.file.read',
            { path },
          );
          setFiles((current) => [
            ...current,
            { path: file.path, saved: file.content, current: file.content, hash: file.hash },
          ]);
        } catch (e) {
          toast((e as Error).message, 'err');
          return;
        }
      }
      setActivePath(path);
      if (line) {
        window.setTimeout(() => {
          editorRef.current?.revealLineInCenter(line);
          editorRef.current?.setPosition({ lineNumber: line, column: 1 });
          editorRef.current?.focus();
        }, 50);
      }
    },
    [files, request, toast],
  );

  const closeFile = (path: string) => {
    const file = files.find((f) => f.path === path);
    if (
      file &&
      file.current !== file.saved &&
      !window.confirm(`${path} has unsaved changes. Close it anyway?`)
    )
      return;
    setFiles((current) => current.filter((f) => f.path !== path));
    if (activePath === path) setActivePath(files.find((f) => f.path !== path)?.path);
  };

  const save = useCallback(
    async (path: string, force = false) => {
      const file = files.find((f) => f.path === path);
      if (!file) return;
      try {
        const written = await request<{ hash: string }>('workspace.file.write', {
          path,
          content: file.current,
          ...(force ? {} : { baseHash: file.hash }),
        });
        ownWrites.current.set(path, written.hash);
        setFiles((current) =>
          current.map((f) =>
            f.path === path ? { ...f, saved: f.current, hash: written.hash, conflict: false } : f,
          ),
        );
        toast(`Saved ${path}`);
      } catch (e) {
        const message = (e as Error).message;
        if (message.includes('changed on disk')) {
          setFiles((current) =>
            current.map((f) => (f.path === path ? { ...f, conflict: true } : f)),
          );
        }
        toast(message, 'err');
      }
    },
    [files, request, toast],
  );

  const reloadFromDisk = useCallback(
    async (path: string) => {
      const file = await request<{ content: string; hash: string }>('workspace.file.read', {
        path,
      });
      setFiles((current) =>
        current.map((f) =>
          f.path === path
            ? { ...f, saved: file.content, current: file.content, hash: file.hash, conflict: false }
            : f,
        ),
      );
    },
    [request],
  );

  // Something else — the agent, an applied change set, another window — changed a file.
  useGatewayEvent('workspace.changed', (payload) => {
    const event = payload as { projectId: string; path: string; reason: string };
    if (event.projectId !== projectId) return;
    refreshTree();
    for (const file of filesRef.current) {
      const affected = event.path === '.' || event.path === file.path;
      if (!affected) continue;
      void request<{ content: string; hash: string }>('workspace.file.read', { path: file.path })
        .then((disk) => {
          // Our own save coming back, or nothing actually changed.
          if (ownWrites.current.get(file.path) === disk.hash) return;
          const latest = filesRef.current.find((f) => f.path === file.path);
          if (!latest || disk.hash === latest.hash) return;
          if (latest.current === latest.saved) {
            setFiles((current) =>
              current.map((f) =>
                f.path === file.path
                  ? { ...f, saved: disk.content, current: disk.content, hash: disk.hash }
                  : f,
              ),
            );
          } else {
            setFiles((current) =>
              current.map((f) => (f.path === file.path ? { ...f, conflict: true } : f)),
            );
          }
        })
        .catch(() => undefined);
    }
  });

  // ---- file operations -------------------------------------------------------------------------

  const createEntry = async (kind: 'file' | 'directory') => {
    const base = activePath ? activePath.split('/').slice(0, -1).join('/') : '';
    const name = window.prompt(
      kind === 'file' ? 'New file path' : 'New folder path',
      base ? `${base}/` : '',
    );
    if (!name?.trim()) return;
    try {
      await request('workspace.file.create', { path: name.trim(), kind });
      refreshTree();
      if (kind === 'file') await openFile(name.trim());
    } catch (e) {
      toast((e as Error).message, 'err');
    }
  };

  const renameEntry = async (path: string) => {
    const to = window.prompt('Rename to', path);
    if (!to?.trim() || to.trim() === path) return;
    try {
      await request('workspace.file.rename', { from: path, to: to.trim() });
      setFiles((current) => current.map((f) => (f.path === path ? { ...f, path: to.trim() } : f)));
      if (activePath === path) setActivePath(to.trim());
      refreshTree();
    } catch (e) {
      toast((e as Error).message, 'err');
    }
  };

  const deleteEntry = async (entry: TreeEntry) => {
    const what =
      entry.type === 'directory' ? `the folder ${entry.path} and everything in it` : entry.path;
    if (
      !window.confirm(
        `Delete ${what}? This cannot be undone from here — take a checkpoint first if unsure.`,
      )
    )
      return;
    try {
      await request('workspace.file.delete', {
        path: entry.path,
        recursive: entry.type === 'directory',
      });
      setFiles((current) =>
        current.filter((f) => f.path !== entry.path && !f.path.startsWith(`${entry.path}/`)),
      );
      refreshTree();
    } catch (e) {
      toast((e as Error).message, 'err');
    }
  };

  // ---- search ----------------------------------------------------------------------------------

  const runSearch = async () => {
    if (!searchQuery.trim()) return setSearchHits(undefined);
    try {
      const result = await request<{ hits: { path: string; line: number; text: string }[] }>(
        'workspace.search',
        { query: searchQuery.trim() },
      );
      setSearchHits(result.hits);
    } catch (e) {
      toast((e as Error).message, 'err');
    }
  };

  // ---- AI actions ------------------------------------------------------------------------------

  useGatewayEvent('chat', (payload) => {
    const event = payload as ChatEventPayload;
    if (!assistant || event.sessionKey !== assistant.sessionKey) return;
    const text = (event.message?.content ?? [])
      .filter((p) => p.type === 'text')
      .map((p) => (p as { text: string }).text)
      .join('');
    if (event.state === 'delta') setAssistant((a) => (a ? { ...a, text } : a));
    else if (event.state === 'final')
      setAssistant((a) => (a ? { ...a, text: text || a.text, running: false } : a));
    else
      setAssistant((a) => (a ? { ...a, text: event.errorMessage ?? a.text, running: false } : a));
  });

  const runAiAction = async (action: (typeof AI_ACTIONS)[number]) => {
    if (!activeFile) return;
    const editor = editorRef.current;
    const selection = editor?.getSelection();
    const model = editor?.getModel();
    const selected = selection && model ? model.getValueInRange(selection) : '';
    const code = selected.trim() ? selected : activeFile.current;
    const scope = selected.trim()
      ? `the selected code (lines ${selection!.startLineNumber}–${selection!.endLineNumber}) of ${activeFile.path}`
      : `the file ${activeFile.path}`;

    const message = [
      `${action.prompt}`,
      '',
      `This is about ${scope} in the project "${projectName}".`,
      '',
      '```' + languageFor(activeFile.path),
      code.slice(0, 40_000),
      '```',
      '',
      action.changesFiles
        ? 'Make the change with the propose_change tool, giving the full new contents of each file you change. Do not write files directly — the developer reviews the proposal under Changes. Then summarise what you changed in two or three sentences.'
        : 'Answer in text only. Do not change any files.',
    ].join('\n');

    setAssistant({ action: action.label, text: '', running: true, sessionKey: editorSession });
    try {
      const { sessionKey } = await request<{ sessionKey: string }>('chat.history', {
        sessionKey: editorSession,
        limit: 1,
      });
      setAssistant((a) => (a ? { ...a, sessionKey } : a));
      await request('chat.send', { sessionKey, message });
    } catch (e) {
      setAssistant((a) => (a ? { ...a, running: false, text: (e as Error).message } : a));
    }
  };

  const explainRepository = async () => {
    const message = [
      `Give me a guided tour of the project "${projectName}".`,
      'Read its README, manifest files and the main source folders. Explain what it does, how it is organised, the entry points, how to build and test it, and where a newcomer should start.',
      'Answer in text only. Do not change any files.',
    ].join('\n');
    setAssistant({
      action: 'Explain this repository',
      text: '',
      running: true,
      sessionKey: editorSession,
    });
    try {
      const { sessionKey } = await request<{ sessionKey: string }>('chat.history', {
        sessionKey: editorSession,
        limit: 1,
      });
      setAssistant((a) => (a ? { ...a, sessionKey } : a));
      await request('chat.send', { sessionKey, message });
    } catch (e) {
      setAssistant((a) => (a ? { ...a, running: false, text: (e as Error).message } : a));
    }
  };

  // ---- editor wiring ---------------------------------------------------------------------------

  const onMount: OnMount = (editor) => {
    editorRef.current = editor;
    editor.addAction({
      id: 'openpulse.save',
      label: 'Save file',
      keybindings: [monacoApi.KeyMod.CtrlCmd | monacoApi.KeyCode.KeyS],
      run: () => {
        const path = activePathRef.current;
        if (path) void saveRef.current(path);
      },
    });
  };

  // Ctrl/Cmd+S is registered once, when the editor mounts, and always saves whatever file is active
  // through these refs — re-registering it on every edit left moments where it was not bound.
  const saveRef = useRef(save);
  saveRef.current = save;
  const activePathRef = useRef(activePath);
  activePathRef.current = activePath;

  const dirtyCount = useMemo(() => files.filter((f) => f.current !== f.saved).length, [files]);

  return (
    <div className="editor-layout">
      <aside className="editor-sidebar">
        <div className="editor-sidebar-head">
          <strong title={projectName}>{projectName}</strong>
          <span className="spacer" />
          <button className="icon" title="New file" onClick={() => void createEntry('file')}>
            ＋
          </button>
          <button className="icon" title="New folder" onClick={() => void createEntry('directory')}>
            ▣
          </button>
          <button className="icon" title="Refresh" onClick={refreshTree}>
            ↻
          </button>
        </div>

        <form
          className="editor-search"
          onSubmit={(event) => {
            event.preventDefault();
            void runSearch();
          }}
        >
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search in project…"
          />
        </form>

        {searchHits ? (
          <div className="tree">
            <div className="tree-note">
              {searchHits.length} match{searchHits.length === 1 ? '' : 'es'}{' '}
              <button className="link" onClick={() => setSearchHits(undefined)}>
                clear
              </button>
            </div>
            {searchHits.map((hit, index) => (
              <button
                key={index}
                className="tree-item hit"
                onClick={() => void openFile(hit.path, hit.line)}
              >
                <span className="mono">
                  {hit.path}:{hit.line}
                </span>
                <span className="faint">{hit.text.trim()}</span>
              </button>
            ))}
          </div>
        ) : (
          <div className="tree">
            <TreeLevel
              dir="."
              depth={0}
              tree={tree}
              expanded={expanded}
              activePath={activePath}
              onToggle={toggleDir}
              onOpen={(path) => void openFile(path)}
              onRename={(path) => void renameEntry(path)}
              onDelete={(entry) => void deleteEntry(entry)}
            />
          </div>
        )}

        <button
          className="btn ghost"
          style={{ margin: '0.5rem' }}
          onClick={() => void explainRepository()}
        >
          ✦ Explain this repository
        </button>
      </aside>

      <section className="editor-main">
        <div className="editor-tabs">
          {files.map((file) => (
            <div key={file.path} className="editor-tab" aria-current={file.path === activePath}>
              <button
                className="editor-tab-name"
                onClick={() => setActivePath(file.path)}
                title={file.path}
              >
                {file.path.split('/').pop()}
                {file.current !== file.saved && <span className="dirty">●</span>}
                {file.conflict && <span className="conflict">!</span>}
              </button>
              <button
                className="editor-tab-close"
                onClick={() => closeFile(file.path)}
                aria-label={`Close ${file.path}`}
              >
                ×
              </button>
            </div>
          ))}
          <span className="spacer" />
          {dirtyCount > 0 && <span className="faint">{dirtyCount} unsaved</span>}
        </div>

        {activeFile?.conflict && (
          <div className="editor-banner">
            <strong>{activeFile.path}</strong> changed on disk while you were editing.
            <button className="btn" onClick={() => void reloadFromDisk(activeFile.path)}>
              Reload from disk (discard my edits)
            </button>
            <button className="btn danger" onClick={() => void save(activeFile.path, true)}>
              Keep mine (overwrite)
            </button>
          </div>
        )}

        {activeFile ? (
          <>
            <div className="editor-toolbar">
              <span className="mono faint">{activeFile.path}</span>
              <span className="spacer" />
              {AI_ACTIONS.map((action) => (
                <button
                  key={action.id}
                  className="btn ghost"
                  onClick={() => void runAiAction(action)}
                  disabled={assistant?.running}
                >
                  {action.label}
                </button>
              ))}
              <button
                className="btn primary"
                onClick={() => void save(activeFile.path)}
                disabled={activeFile.current === activeFile.saved || prefs.readOnly}
              >
                Save
              </button>
            </div>
            <div className="editor-host">
              <Editor
                path={`${projectId}/${activeFile.path}`}
                language={languageFor(activeFile.path)}
                value={activeFile.current}
                theme={document.documentElement.dataset.theme === 'light' ? 'vs' : 'openpulse-dark'}
                onMount={onMount}
                onChange={(value) =>
                  setFiles((current) =>
                    current.map((f) =>
                      f.path === activeFile.path ? { ...f, current: value ?? '' } : f,
                    ),
                  )
                }
                options={{
                  fontSize: prefs.fontSize,
                  wordWrap: prefs.wordWrap ? 'on' : 'off',
                  minimap: { enabled: prefs.minimap },
                  readOnly: prefs.readOnly,
                  automaticLayout: true,
                  scrollBeyondLastLine: false,
                  renderWhitespace: 'selection',
                  tabSize: 2,
                }}
              />
            </div>
          </>
        ) : (
          <div className="empty" style={{ margin: 'auto' }}>
            Open a file from the tree. Select code and use the AI actions to explain it, or to
            propose a change you can review.
          </div>
        )}

        <div className="editor-status">
          <label>
            <input
              type="checkbox"
              checked={prefs.readOnly}
              onChange={(e) => setPrefs({ ...prefs, readOnly: e.target.checked })}
            />{' '}
            Read-only
          </label>
          <label>
            <input
              type="checkbox"
              checked={prefs.wordWrap}
              onChange={(e) => setPrefs({ ...prefs, wordWrap: e.target.checked })}
            />{' '}
            Wrap
          </label>
          <label>
            <input
              type="checkbox"
              checked={prefs.minimap}
              onChange={(e) => setPrefs({ ...prefs, minimap: e.target.checked })}
            />{' '}
            Minimap
          </label>
          <label>
            Font
            <select
              value={prefs.fontSize}
              onChange={(e) => setPrefs({ ...prefs, fontSize: Number(e.target.value) })}
              style={{ width: 'auto', marginLeft: '0.3rem' }}
            >
              {[11, 12, 13, 14, 15, 16, 18].map((size) => (
                <option key={size} value={size}>
                  {size}
                </option>
              ))}
            </select>
          </label>
          <span className="spacer" />
          <span className="faint">Ctrl+S save · Ctrl+F find · Ctrl+H replace</span>
        </div>
      </section>

      {assistant && (
        <aside className="editor-assistant">
          <div className="editor-sidebar-head">
            <strong>✦ {assistant.action}</strong>
            <span className="spacer" />
            <button className="icon" onClick={() => setAssistant(undefined)} aria-label="Close">
              ×
            </button>
          </div>
          <div className="editor-assistant-body">
            {assistant.text ? (
              <div className="bubble" style={{ whiteSpace: 'pre-wrap' }}>
                {assistant.text}
              </div>
            ) : null}
            {assistant.running && <div className="thinking">working…</div>}
            {!assistant.running && (
              <p className="faint" style={{ fontSize: 12 }}>
                Any file changes were proposed, not written.{' '}
                <button
                  className="link"
                  onClick={() => {
                    window.location.hash = '#/changes';
                  }}
                >
                  Review them under Changes
                </button>
                .
              </p>
            )}
          </div>
        </aside>
      )}
    </div>
  );
}

function TreeLevel(props: {
  dir: string;
  depth: number;
  tree: Record<string, TreeEntry[]>;
  expanded: Set<string>;
  activePath: string | undefined;
  onToggle: (dir: string) => void;
  onOpen: (path: string) => void;
  onRename: (path: string) => void;
  onDelete: (entry: TreeEntry) => void;
}): JSX.Element {
  const entries = props.tree[props.dir];
  if (!entries)
    return (
      <div className="tree-note" style={{ paddingLeft: `${props.depth + 1}rem` }}>
        loading…
      </div>
    );
  if (entries.length === 0)
    return (
      <div className="tree-note" style={{ paddingLeft: `${props.depth + 1}rem` }}>
        empty
      </div>
    );
  return (
    <>
      {entries.map((entry) => (
        <div key={entry.path}>
          <div
            className="tree-item"
            aria-current={entry.path === props.activePath}
            style={{ paddingLeft: `${props.depth * 0.9 + 0.5}rem` }}
            onClick={() =>
              entry.type === 'directory' ? props.onToggle(entry.path) : props.onOpen(entry.path)
            }
            title={entry.path}
          >
            <span className="tree-icon">
              {entry.type === 'directory' ? (props.expanded.has(entry.path) ? '▾' : '▸') : '·'}
            </span>
            <span className="tree-name">{entry.name}</span>
            <span className="tree-actions">
              <button
                title={`Rename ${entry.path}`}
                onClick={(event) => {
                  event.stopPropagation();
                  props.onRename(entry.path);
                }}
              >
                ✎
              </button>
              <button
                title={`Delete ${entry.path}`}
                onClick={(event) => {
                  event.stopPropagation();
                  props.onDelete(entry);
                }}
              >
                ✕
              </button>
            </span>
          </div>
          {entry.type === 'directory' && props.expanded.has(entry.path) && (
            <TreeLevel {...props} dir={entry.path} depth={props.depth + 1} />
          )}
        </div>
      ))}
    </>
  );
}
