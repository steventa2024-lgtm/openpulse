import os from 'node:os';
import path from 'node:path';
import { isWithin } from '../tools/paths.js';
import type { RiskAssessment } from '../tools/types.js';

interface Rule {
  pattern: RegExp;
  reason: string;
}

/**
 * Match a command word only in command position: at the start, or after whitespace, `;`, `|`,
 * `&` or `(`, and followed by whitespace/end. Unlike `\b`, this doesn't treat `.` as a boundary,
 * so the `md` alias doesn't match `README.md`.
 */
function cmd(words: string): RegExp {
  return new RegExp(`(?:^|[\\s;|&(])(?:${words})(?=\\s|$|;)`, 'i');
}

/**
 * Catastrophic commands: never run, whatever the policy mode or approval. These wipe disks, the
 * root filesystem, the user's home directory, or fork-bomb the machine.
 */
const BLOCKED: Rule[] = [
  {
    pattern: /\brm\s+(-[a-z]*\s+)*-[a-z]*r[a-z]*\s+(-[a-z]+\s+)*(\/|\/\*|~|~\/|\$HOME)(\s|$)/i,
    reason: 'recursive delete of the root or home directory',
  },
  { pattern: /\brm\s+.*--no-preserve-root/i, reason: 'rm with --no-preserve-root' },
  { pattern: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, reason: 'fork bomb' },
  { pattern: /\bmkfs(\.[a-z0-9]+)?\b/i, reason: 'formats a filesystem' },
  {
    pattern: /\bdd\b[^|;&]*\bof=\/dev\/(sd|hd|nvme|disk|mmcblk)/i,
    reason: 'writes raw data to a disk device',
  },
  {
    pattern: />\s*\/dev\/(sd|hd|nvme|disk|mmcblk)[a-z0-9]*/i,
    reason: 'writes raw data to a disk device',
  },
  { pattern: /\bformat(\.com)?\s+[a-z]:/i, reason: 'formats a drive' },
  {
    pattern: /\bFormat-Volume\b|\bClear-Disk\b|\bInitialize-Disk\b/i,
    reason: 'formats or wipes a disk',
  },
  { pattern: /\bdiskpart\b/i, reason: 'disk partitioning' },
  {
    pattern:
      /\bRemove-Item\b[^|;]*-Recurse[^|;]*\s['"]?(?:[a-z]:\\?|~|\$HOME|\$env:USERPROFILE|\\)['"]?(\s|$)/i,
    reason: 'recursive delete of a drive root or home directory',
  },
  {
    pattern: /\b(rd|rmdir)\s+\/s\b[^|;&]*\s[a-z]:\\?(\s|$)/i,
    reason: 'recursive delete of a drive root',
  },
  { pattern: /\bdel\s+(\/[a-z]\s+)*[a-z]:\\\*?(\s|$)/i, reason: 'deletes a drive root' },
];

/** High risk: destructive, privileged, or hard to reverse. Needs approval in balanced mode. */
const HIGH: Rule[] = [
  { pattern: cmd('rm|ri|rmdir|rd|del|erase|unlink'), reason: 'deletes files' },
  { pattern: /\bRemove-Item\b/i, reason: 'deletes files' },
  { pattern: cmd('shred|wipe|srm'), reason: 'destroys file contents' },
  { pattern: cmd('sudo|doas|su|runas'), reason: 'runs with elevated privileges' },
  { pattern: /\bStart-Process\b[^|;]*-Verb\s+RunAs/i, reason: 'runs with elevated privileges' },
  { pattern: cmd('shutdown|reboot|halt|poweroff'), reason: 'shuts down or restarts the machine' },
  { pattern: /\b(Stop|Restart)-Computer\b/i, reason: 'shuts down or restarts the machine' },
  { pattern: cmd('kill|pkill|killall|taskkill'), reason: 'terminates processes' },
  { pattern: /\bStop-Process\b/i, reason: 'terminates processes' },
  {
    pattern:
      /\b(systemctl|service)\s+(stop|disable|mask|restart)\b|\b(Stop|Remove|Set)-Service\b|\bsc(\.exe)?\s+(stop|delete|config)\b/i,
    reason: 'changes system services',
  },
  {
    pattern:
      /\bchmod\b\s+(-[a-z]*R|[0-7]*7[0-7]{2}\b)|\bchown\b|\bicacls\b|\btakeown\b|\bSet-Acl\b/i,
    reason: 'changes file permissions or ownership',
  },
  {
    pattern:
      /\bgit\s+(push\b[^|;&]*(--force|-f\b)|reset\s+--hard|clean\s+-[a-z]*f|branch\s+-D|checkout\s+--\s|stash\s+(drop|clear)|filter-branch|rebase)/i,
    reason: 'rewrites or discards git history/changes',
  },
  {
    pattern:
      /\b(curl|wget|iwr|Invoke-WebRequest|irm|Invoke-RestMethod)\b[^|]*\|\s*(ba|z|k)?sh\b|\|\s*(iex|Invoke-Expression)\b/i,
    reason: 'pipes a downloaded script into a shell',
  },
  { pattern: /\bInvoke-Expression\b/i, reason: 'evaluates dynamic code' },
  { pattern: cmd('iex'), reason: 'evaluates dynamic code' },
  {
    pattern:
      /\b(reg(\.exe)?\s+(add|delete|import))\b|\b(Set|New|Remove)-ItemProperty\b[^|;]*HK(LM|CU)/i,
    reason: 'modifies the Windows registry',
  },
  {
    pattern:
      /\bSet-ExecutionPolicy\b|\bSet-MpPreference\b|\bnetsh\b[^|;]*(firewall|advfirewall)|\bufw\s+(disable|allow|delete)|\biptables\b/i,
    reason: 'changes security settings',
  },
  {
    pattern:
      /\bcrontab\s+-r\b|\bschtasks\b[^|;]*\/(create|delete|change)|\b(Register|Unregister)-ScheduledTask\b/i,
    reason: 'changes scheduled tasks',
  },
  {
    pattern:
      /\b(npm|pnpm|yarn)\s+publish\b|\bdocker\s+(system\s+prune|rm|rmi|volume\s+rm)\b|\bkubectl\s+delete\b|\bterraform\s+(apply|destroy)\b/i,
    reason: 'publishes or deletes infrastructure/artifacts',
  },
  {
    pattern: /\b(drop|truncate)\s+(table|database|schema)\b|\bdelete\s+from\b/i,
    reason: 'deletes database data',
  },
  { pattern: cmd('mv|move|ren|rename'), reason: 'moves or renames files (can overwrite)' },
  { pattern: /\b(Move-Item|Rename-Item)\b/i, reason: 'moves or renames files (can overwrite)' },
  { pattern: /(^|[^>])>\s*[^&\s|>]/, reason: 'redirects output into a file (overwrites it)' },
  { pattern: /\b(Set-Content|Out-File|Clear-Content)\b/i, reason: 'overwrites file contents' },
  { pattern: cmd('truncate'), reason: 'overwrites file contents' },
  {
    pattern:
      /\b(apt(-get)?|yum|dnf|pacman|brew|choco|winget|scoop)\s+(install|remove|uninstall|purge|upgrade)\b|\bpip3?\s+(install|uninstall)\b|\bnpm\s+(i|install|uninstall)\s+-g\b/i,
    reason: 'installs or removes software',
  },
  { pattern: cmd('ssh|scp|rsync|sftp'), reason: 'connects to or copies to another machine' },
  {
    pattern:
      /\b(curl|wget)\b[^|;]*(-X\s*(POST|PUT|DELETE|PATCH)|--data|-d\s|-F\s|--upload-file|-T\s)/i,
    reason: 'sends data to a remote server',
  },
  {
    pattern:
      /\b(Invoke-WebRequest|Invoke-RestMethod|iwr|irm)\b[^|;]*-Method\s+(Post|Put|Delete|Patch)/i,
    reason: 'sends data to a remote server',
  },
];

/** Medium: changes state in limited, expected ways. Needs approval in strict mode. */
const MEDIUM: Rule[] = [
  { pattern: cmd('mkdir|md|touch|cp|copy|xcopy|robocopy|tee'), reason: 'creates or copies files' },
  { pattern: /\b(New-Item|Copy-Item|Add-Content)\b/i, reason: 'creates or copies files' },
  { pattern: />>/, reason: 'appends to a file' },
  {
    pattern: /\bgit\s+(commit|push|pull|merge|checkout|switch|add|stash|tag|clone)\b/i,
    reason: 'changes a git repository',
  },
  {
    pattern: /\b(npm|pnpm|yarn|pip3?|cargo|go)\s+(install|add|remove|i|update|upgrade|get)\b/i,
    reason: 'changes project dependencies',
  },
  { pattern: /\bStart-Process\b/i, reason: 'launches a program' },
  { pattern: cmd('start|open|xdg-open|explorer'), reason: 'launches a program' },
  {
    pattern: /\b(curl|wget|Invoke-WebRequest|Invoke-RestMethod|iwr|irm)\b/i,
    reason: 'accesses the network',
  },
];

export interface ShellRiskOptions {
  /** User regexes: matching commands are never "ask" (they can still be blocked). */
  allow?: string[];
  /** User regexes: matching commands are always blocked. */
  deny?: string[];
}

export function assessShellCommand(
  command: string,
  options: ShellRiskOptions = {},
): RiskAssessment {
  const cmd = command.trim();

  for (const rule of BLOCKED) {
    if (rule.pattern.test(cmd)) return { level: 'blocked', reason: rule.reason };
  }
  for (const source of options.deny ?? []) {
    if (safeRegex(source)?.test(cmd))
      return { level: 'blocked', reason: `matches deny rule /${source}/` };
  }
  for (const source of options.allow ?? []) {
    if (safeRegex(source)?.test(cmd))
      return { level: 'low', reason: `matches allow rule /${source}/` };
  }
  for (const rule of HIGH) {
    if (rule.pattern.test(cmd)) return { level: 'high', reason: rule.reason };
  }
  for (const rule of MEDIUM) {
    if (rule.pattern.test(cmd)) return { level: 'medium', reason: rule.reason };
  }
  return { level: 'low', reason: 'no state-changing patterns detected' };
}

function safeRegex(source: string): RegExp | undefined {
  try {
    return new RegExp(source, 'i');
  } catch {
    return undefined;
  }
}

const SENSITIVE_NAMES =
  /(^|[\\/])(\.ssh|\.gnupg|\.aws|\.azure|\.kube|\.docker|\.netrc|\.npmrc|\.pypirc|\.git-credentials|id_rsa|id_ed25519|.*\.pem|.*\.key|.*\.pfx|.*\.p12|\.env(\..*)?|credentials(\.json)?|Login Data|Cookies)$|[\\/](\.ssh|\.gnupg|\.aws)[\\/]/i;

const SYSTEM_DIRS =
  process.platform === 'win32'
    ? [
        process.env.SystemRoot ?? 'C:\\Windows',
        process.env.ProgramFiles ?? 'C:\\Program Files',
        process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)',
        process.env.ProgramData ?? 'C:\\ProgramData',
      ]
    : [
        '/etc',
        '/bin',
        '/sbin',
        '/usr',
        '/boot',
        '/lib',
        '/lib64',
        '/System',
        '/Library',
        '/var/lib',
      ];

export interface FileRiskContext {
  /** The agent's own workspace (config.yaml holds secrets and the policy itself). */
  workspaceDir: string;
  /** Files the agent itself produces; writing here is always low risk. */
  scratchDir: string;
}

export function assessFileAccess(
  mode: 'read' | 'write',
  absolutePath: string,
  ctx: FileRiskContext,
): RiskAssessment {
  const configFile = path.join(ctx.workspaceDir, 'config.yaml');
  const isConfig = path.resolve(absolutePath).toLowerCase() === configFile.toLowerCase();

  if (mode === 'read') {
    if (isConfig)
      return { level: 'high', reason: 'reads OpenPulse settings, which contain API keys' };
    if (SENSITIVE_NAMES.test(absolutePath))
      return { level: 'high', reason: 'reads a file that likely contains credentials' };
    return { level: 'low', reason: 'reads a file' };
  }

  if (isConfig)
    return {
      level: 'high',
      reason: 'modifies OpenPulse settings (including its own permissions policy)',
    };
  if (isWithin(ctx.scratchDir, absolutePath))
    return { level: 'low', reason: "writes into the agent's scratch folder" };
  if (SENSITIVE_NAMES.test(absolutePath))
    return { level: 'high', reason: 'writes a credentials/key file' };
  if (SYSTEM_DIRS.some((dir) => isWithin(dir, absolutePath)))
    return { level: 'high', reason: 'writes into a system directory' };
  if (
    /(^|[\\/])(\.bashrc|\.zshrc|\.profile|\.bash_profile|Microsoft\.PowerShell_profile\.ps1|authorized_keys)$/i.test(
      absolutePath,
    ) ||
    /[\\/]Start Menu[\\/]Programs[\\/]Startup[\\/]/i.test(absolutePath)
  ) {
    return { level: 'high', reason: 'modifies a shell profile or startup file' };
  }
  if (!isWithin(os.homedir(), absolutePath))
    return { level: 'high', reason: 'writes outside the home directory' };
  return { level: 'medium', reason: 'writes a file' };
}
