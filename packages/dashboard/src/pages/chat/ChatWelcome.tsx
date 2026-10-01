import type { JSX } from 'react';
import {
  ArrowRight,
  Bug,
  ClipboardList,
  Code2,
  FlaskConical,
  Layers,
  type LucideIcon,
  Wand2,
} from 'lucide-react';
import { HaloMark } from '../../components/Halo.js';

interface Starter {
  title: string;
  body: string;
  icon: LucideIcon;
  tone: string;
  prompt: string;
}

/** Starting points. Picking one fills the message box; nothing is sent until you press Enter. */
const STARTERS: Starter[] = [
  {
    title: 'Build a feature',
    body: 'Implement a complete feature from your requirements',
    icon: Layers,
    tone: 'violet',
    prompt: 'Build this feature, and propose the changes for my review with propose_change:\n\n',
  },
  {
    title: 'Explain code',
    body: 'Walk through and explain how something works',
    icon: Code2,
    tone: 'blue',
    prompt: 'Read the relevant files and explain how this works:\n\n',
  },
  {
    title: 'Fix an issue',
    body: 'Debug errors and propose solutions',
    icon: Bug,
    tone: 'red',
    prompt: 'Find the cause of this problem and propose a fix for my review:\n\n',
  },
  {
    title: 'Plan changes',
    body: 'Break down and plan a set of changes',
    icon: ClipboardList,
    tone: 'green',
    prompt: 'Read the project and write a step-by-step plan, without changing any files, for:\n\n',
  },
  {
    title: 'Write tests',
    body: 'Design and run tests for your code',
    icon: FlaskConical,
    tone: 'amber',
    prompt: 'Write tests for the following, propose them for review, then run the test suite:\n\n',
  },
  {
    title: 'Refactor',
    body: 'Improve code structure and quality',
    icon: Wand2,
    tone: 'rose',
    prompt:
      'Refactor this for clarity without changing behaviour, and propose the changes for review:\n\n',
  },
];

export function ChatWelcome({
  projectName,
  onPick,
}: {
  projectName?: string;
  onPick: (prompt: string) => void;
}): JSX.Element {
  return (
    <div className="chat-welcome">
      <HaloMark className="chat-welcome-halo" />
      <h2>How can I help you today?</h2>
      <p>
        I can read and write files, run commands, browse your project, analyze code, and help you
        build{projectName ? ` in ${projectName}` : ''}.
      </p>
      <div className="starter-grid">
        {STARTERS.map((starter) => (
          <button key={starter.title} className="starter" onClick={() => onPick(starter.prompt)}>
            <span className={`starter-icon ${starter.tone}`}>
              <starter.icon aria-hidden />
            </span>
            <ArrowRight className="starter-arrow" aria-hidden />
            <strong>{starter.title}</strong>
            <span>{starter.body}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
