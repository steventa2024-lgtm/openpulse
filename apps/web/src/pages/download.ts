import { html } from '../html.js';
import type { Page } from '../layout.js';
import { RELEASES_API, RELEASES_URL, REPO_URL, href } from '../site.js';

export function downloadPage(): Page {
  return {
    path: '/download/',
    title: 'Download',
    section: 'download',
    description:
      'Download OpenPulse for Windows: the installer or the portable build, straight from the project’s GitHub releases.',
    scripts: ['download'],
    body: html`
      <section class="page-head">
        <div class="wrap">
          <p class="eyebrow">Download</p>
          <h1>OpenPulse for Windows</h1>
          <p class="lead">
            Windows 10 or 11, 64-bit. Files come straight from the project’s GitHub releases.
          </p>
        </div>
      </section>

      <section class="section">
        <div class="wrap">
          <div
            id="download-root"
            class="download-panel"
            data-api="${RELEASES_API}"
            data-releases="${RELEASES_URL}"
            aria-live="polite"
          >
            <p class="muted">Checking GitHub for the latest release…</p>
            <noscript>
              <p>
                This page asks GitHub for the latest release, which needs JavaScript. You can pick a
                file yourself on the
                <a href="${RELEASES_URL}" rel="noopener">GitHub releases page</a>.
              </p>
            </noscript>
          </div>
        </div>
      </section>

      <section class="section section-alt">
        <div class="wrap card-grid card-grid-2">
          <div class="card">
            <h2>Installer or portable?</h2>
            <p>
              <strong>Installer</strong> (<code>OpenPulse-Setup-&lt;version&gt;-x64.exe</code>)
              installs for your user account by default (no admin rights needed), lets you choose
              the folder, adds Start menu and desktop shortcuts, and can be uninstalled from Windows
              Settings.
            </p>
            <p>
              <strong>Portable</strong> (<code>OpenPulse-Portable-&lt;version&gt;-x64.exe</code>)
              runs without installing — handy for trying it out or a USB stick.
            </p>
            <p>
              Both keep your agent’s data in <code>%USERPROFILE%\\.openpulse</code>. Installing,
              upgrading and uninstalling never delete it.
            </p>
          </div>
          <div class="card">
            <h2>“Windows protected your PC”</h2>
            <p>
              A build that is not code-signed — the release notes say which — makes SmartScreen warn
              the first time you run it. Check the checksum below first; then choose
              <em>More info</em> → <em>Run anyway</em>.
            </p>
            <p>
              Signed builds will be published once the project has a signing certificate. Nothing
              here will call a build signed when it is not.
            </p>
          </div>
          <div class="card">
            <h2>Verify your download</h2>
            <p>Each release lists a SHA-256 checksum for every file. In PowerShell:</p>
            <pre><code>Get-FileHash .\\OpenPulse-Setup-*-x64.exe -Algorithm SHA256</code></pre>
            <p>
              The hash it prints must match the one on this page or in
              <code>SHA256SUMS.txt</code> on the release.
            </p>
          </div>
          <div class="card">
            <h2>What you need</h2>
            <ul>
              <li>Windows 10 or 11, 64-bit. No Node.js or other runtime to install.</li>
              <li>
                For local models: <a href="https://ollama.com" rel="noopener">Ollama</a> or
                <a href="https://lmstudio.ai" rel="noopener">LM Studio</a>, and enough RAM or VRAM
                for the model you pick.
              </li>
              <li>Git, if you want to clone repositories and use checkpoints.</li>
            </ul>
            <p>
              <a class="text-link" href="${href('/docs/getting-started/')}">Quick start guide →</a>
            </p>
          </div>
        </div>
      </section>

      <section class="section">
        <div class="wrap narrow">
          <h2 class="section-title">Build it yourself</h2>
          <p>
            Everything on this page is built from the public source. To build the installer on your
            own machine:
          </p>
          <pre><code>git clone ${REPO_URL}.git
cd openpulse
pnpm install
pnpm build
pnpm desktop:package</code></pre>
          <p class="muted">
            The installer and portable build are written to <code>apps/desktop/release/</code>.
          </p>
        </div>
      </section>
    `,
  };
}
