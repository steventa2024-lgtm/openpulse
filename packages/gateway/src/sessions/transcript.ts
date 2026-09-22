import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

// Transcript format: one JSON object per line.
//   {"type":"session","version":1,"id":"<sessionId>","timestamp":"…","cwd":"…"}
//   {"type":"message","id":"…","timestamp":"…","message":{ role, content, timestamp, … }}

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'toolCall'; id: string; name: string; arguments: unknown }
  | { type: 'image'; mimeType: string; data: string };

export interface UserMessage {
  role: 'user';
  content: ContentPart[];
  timestamp: number;
  /** Where it came from, e.g. "telegram:42", "webchat", "heartbeat", "cron:<id>". */
  source?: string;
  senderName?: string;
}

export interface AssistantMessage {
  role: 'assistant';
  content: ContentPart[];
  timestamp: number;
  provider?: string;
  model?: string;
  usage?: { input: number; output: number; total: number };
  stopReason?: 'stop' | 'toolUse' | 'length' | 'aborted' | 'error';
  /** Written by chat.inject (UI-only note, no agent run). */
  injected?: boolean;
  errorMessage?: string;
}

export interface ToolResultMessage {
  role: 'toolResult';
  toolCallId: string;
  toolName: string;
  content: ContentPart[];
  isError: boolean;
  timestamp: number;
}

export type TranscriptMessage = UserMessage | AssistantMessage | ToolResultMessage;

export interface TranscriptEntry {
  type: 'message';
  id: string;
  timestamp: string;
  message: TranscriptMessage;
}

export function transcriptPath(sessionsDir: string, sessionId: string): string {
  return path.join(sessionsDir, `${sessionId}.jsonl`);
}

export async function appendTranscript(
  file: string,
  sessionId: string,
  message: TranscriptMessage,
  cwd?: string,
): Promise<TranscriptEntry> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  let prefix = '';
  if (!fs.existsSync(file)) {
    prefix = `${JSON.stringify({ type: 'session', version: 1, id: sessionId, timestamp: new Date().toISOString(), cwd })}\n`;
  }
  const entry: TranscriptEntry = {
    type: 'message',
    id: randomUUID().slice(0, 8),
    timestamp: new Date(message.timestamp).toISOString(),
    message,
  };
  await fsp.appendFile(file, `${prefix}${JSON.stringify(entry)}\n`, 'utf8');
  return entry;
}

export async function readTranscript(file: string): Promise<TranscriptEntry[]> {
  let text: string;
  try {
    text = await fsp.readFile(file, 'utf8');
  } catch {
    return [];
  }
  const out: TranscriptEntry[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line) as { type?: string };
      if (obj.type === 'message') out.push(obj as TranscriptEntry);
    } catch {
      // Skip a corrupt line rather than losing the whole transcript.
    }
  }
  return out;
}

export function textOf(parts: ContentPart[]): string {
  return parts
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('\n')
    .trim();
}
