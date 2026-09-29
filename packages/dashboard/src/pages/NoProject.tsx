import type { JSX } from 'react';
import { Card, PageHead } from '../components/ui.js';

/** Shown on workspace pages until a project is registered and selected. */
export function NoProject({ title }: { title: string }): JSX.Element {
  return (
    <>
      <PageHead title={title} />
      <Card>
        <div className="empty">
          <p style={{ marginTop: 0 }}>No project is selected yet.</p>
          <p className="muted">
            Add a folder or clone a repository under Projects. The agent can only read and change
            the projects you register.
          </p>
          <button
            className="btn primary"
            onClick={() => {
              window.location.hash = '#/projects';
            }}
          >
            Go to Projects
          </button>
        </div>
      </Card>
    </>
  );
}
