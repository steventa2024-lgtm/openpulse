import type { JSX } from 'react';
import { useState } from 'react';
import { Check, Diamond, FolderOpen, MessageSquare, X } from 'lucide-react';
import { HaloMark } from '../components/Halo.js';
import { useAction } from '../components/ui.js';
import { useGateway, useGatewayEvent, useQuery } from '../gateway/provider.js';
import { modelReadiness, type DetectSnapshot } from '../onboarding.js';
import { useProject } from '../project/provider.js';
import type { SessionRow } from '../types.js';

const DISMISSED_KEY = 'openpulse.onboarding.dismissed';

/**
 * First-run setup on the Overview: a model that can actually answer, a project to work in, and a
 * first conversation. Each step's state comes from the gateway; the card goes away once all three
 * are done, or when dismissed.
 */
export function GetStarted(): JSX.Element | null {
  const { request } = useGateway();
  const act = useAction();
  const { projects } = useProject();
  const detect = useQuery<DetectSnapshot>('models.detect');
  const sessions = useQuery<{ sessions: SessionRow[] }>('sessions.list', { limit: 50 });
  const [dismissed, setDismissed] = useState(() => readDismissed());
  useGatewayEvent(['config.changed', 'sessions.changed'], () => {
    detect.reload();
    sessions.reload();
  });

  if (dismissed || !detect.data || !sessions.data) return null;

  const model = modelReadiness(detect.data);
  const modelDone = model.state === 'ready' || model.state === 'unknown';
  const projectDone = projects.length > 0;
  const chatDone = sessions.data.sessions.some((s) => s.totalTokens > 0);
  if (modelDone && projectDone && chatDone) return null;

  const chooseModel = (ref: string) =>
    act(async () => {
      await request('models.use', { primary: ref });
      detect.reload();
    }, `Default model set to ${ref}`);

  return (
    <section className="get-started card">
      <button
        className="icon get-started-close"
        title="Hide this guide"
        onClick={() => {
          writeDismissed();
          setDismissed(true);
        }}
      >
        <X aria-hidden />
      </button>
      <div className="get-started-head">
        <HaloMark className="get-started-halo" />
        <div>
          <h2>Get started with OpenPulse</h2>
          <p>Three steps and your agent can work on your code, on your machine.</p>
        </div>
      </div>
      <ol className="get-started-steps">
        <Step
          done={modelDone}
          icon={<Diamond aria-hidden />}
          title="Choose a model that can answer"
          detail={model.detail}
        >
          {!modelDone && 'suggestion' in model && model.suggestion && (
            <button className="btn primary" onClick={() => void chooseModel(model.suggestion!)}>
              Use {model.suggestion}
            </button>
          )}
          {!modelDone && (
            <a className="btn" href="#/models">
              Open Models
            </a>
          )}
        </Step>
        <Step
          done={projectDone}
          icon={<FolderOpen aria-hidden />}
          title="Add a project"
          detail={
            projectDone
              ? `${projects.length} project${projects.length === 1 ? '' : 's'} registered.`
              : 'Open a folder or clone a repository so the agent knows where to work.'
          }
        >
          {!projectDone && (
            <a className="btn" href="#/projects">
              Add a project
            </a>
          )}
        </Step>
        <Step
          done={chatDone}
          icon={<MessageSquare aria-hidden />}
          title="Ask your first question"
          detail={
            chatDone
              ? 'You have talked to the agent.'
              : 'Try “Explain how this project is structured” in Chat.'
          }
        >
          {!chatDone && (
            <a className="btn" href="#/chat">
              Open Chat
            </a>
          )}
        </Step>
      </ol>
    </section>
  );
}

function Step({
  done,
  icon,
  title,
  detail,
  children,
}: {
  done: boolean;
  icon: JSX.Element;
  title: string;
  detail: string;
  children?: React.ReactNode;
}): JSX.Element {
  return (
    <li className={`get-started-step${done ? ' done' : ''}`}>
      <span className="get-started-icon">{done ? <Check aria-hidden /> : icon}</span>
      <div>
        <strong>{title}</strong>
        <p>{detail}</p>
        {!done && children && <div className="get-started-actions">{children}</div>}
      </div>
    </li>
  );
}

function readDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISSED_KEY) === '1';
  } catch {
    return false;
  }
}

function writeDismissed(): void {
  try {
    localStorage.setItem(DISMISSED_KEY, '1');
  } catch {
    // ignore
  }
}
