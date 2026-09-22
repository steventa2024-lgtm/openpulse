import os from 'node:os';
import path from 'node:path';

/**
 * On-disk layout (mirrors OpenClaw's ~/.openclaw):
 *
 *   ~/.openpulse/
 *     openpulse.json                 config (JSON5)
 *     workspace/                     agent workspace (AGENTS.md, SOUL.md, memory/, skills/ …)
 *     agents/<agentId>/sessions/     sessions.json + <sessionId>.jsonl transcripts
 *     cron/jobs.json, cron/runs/     scheduler store + run history
 *     credentials/                   channel pairing + allowlists
 *     devices/                       paired Control UI / CLI devices
 *     identity/                      this machine's device key (CLI)
 *     exec-approvals.json            exec allowlist + ask policy
 *     skills/                        managed (shared) skills
 *     logs/openpulse-YYYY-MM-DD.log  JSONL gateway log
 */
export interface StatePaths {
  stateDir: string;
  configPath: string;
  defaultWorkspace: string;
  credentialsDir: string;
  devicesDir: string;
  identityDir: string;
  cronDir: string;
  logsDir: string;
  managedSkillsDir: string;
  execApprovalsPath: string;
  agentDir: (agentId: string) => string;
  sessionsDir: (agentId: string) => string;
}

export function resolveStateDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.OPENPULSE_STATE_DIR) return expandHome(env.OPENPULSE_STATE_DIR);
  const home = env.OPENPULSE_HOME ? expandHome(env.OPENPULSE_HOME) : os.homedir();
  const profile = env.OPENPULSE_PROFILE?.trim();
  return path.join(home, profile ? `.openpulse-${profile}` : '.openpulse');
}

export function resolvePaths(stateDir: string, env: NodeJS.ProcessEnv = process.env): StatePaths {
  const root = path.resolve(stateDir);
  return {
    stateDir: root,
    configPath: env.OPENPULSE_CONFIG_PATH
      ? expandHome(env.OPENPULSE_CONFIG_PATH)
      : path.join(root, 'openpulse.json'),
    defaultWorkspace: path.join(root, 'workspace'),
    credentialsDir: path.join(root, 'credentials'),
    devicesDir: path.join(root, 'devices'),
    identityDir: path.join(root, 'identity'),
    cronDir: path.join(root, 'cron'),
    logsDir: path.join(root, 'logs'),
    managedSkillsDir: path.join(root, 'skills'),
    execApprovalsPath: path.join(root, 'exec-approvals.json'),
    agentDir: (agentId) => path.join(root, 'agents', agentId),
    sessionsDir: (agentId) => path.join(root, 'agents', agentId, 'sessions'),
  };
}

export function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}
