import type { JSX, ReactNode } from 'react';
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useGateway, useGatewayEvent } from '../gateway/provider.js';

export interface Project {
  id: string;
  name: string;
  path: string;
  createdAt: number;
  lastOpenedAt?: number;
  vcs: 'git' | 'none';
  remote?: string;
  defaultBranch?: string;
  extraReadRoots: string[];
}

interface ProjectContextValue {
  projects: Project[];
  active: Project | undefined;
  loading: boolean;
  error: string | undefined;
  select: (id: string) => Promise<void>;
  refresh: () => void;
}

const ProjectContext = createContext<ProjectContextValue | undefined>(undefined);

/**
 * The project every workspace page acts on. There is one active project per gateway, so the
 * editor, git, changes, checkpoints and test pages all agree on where they are working — and a
 * change of project in one window is reflected in every other.
 */
export function ProjectProvider({ children }: { children: ReactNode }): JSX.Element {
  const { request, status } = useGateway();
  const [projects, setProjects] = useState<Project[]>([]);
  const [active, setActive] = useState<Project>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (status.state !== 'open') return;
    let cancelled = false;
    request<{ projects: Project[]; active: Project | null }>('projects.list')
      .then((result) => {
        if (cancelled) return;
        setProjects(result.projects);
        setActive(result.active ?? undefined);
        setError(undefined);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError((e as Error).message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [request, status.state, nonce]);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);
  useGatewayEvent('projects.changed', refresh);

  const select = useCallback(
    async (id: string) => {
      await request('projects.select', { id });
      refresh();
    },
    [request, refresh],
  );

  const value = useMemo(
    () => ({ projects, active, loading, error, select, refresh }),
    [projects, active, loading, error, select, refresh],
  );
  return <ProjectContext.Provider value={value}>{children}</ProjectContext.Provider>;
}

export function useProject(): ProjectContextValue {
  const ctx = useContext(ProjectContext);
  if (!ctx) throw new Error('useProject must be used inside <ProjectProvider>');
  return ctx;
}
