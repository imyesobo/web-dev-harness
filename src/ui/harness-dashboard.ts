import { LitElement, css, html, nothing } from 'lit';
import { LionButton } from '@lion/ui/button.js';
import { LionCheckbox } from '@lion/ui/checkbox-group.js';
import { LionInput } from '@lion/ui/input.js';
import type { SessionRecord, SessionStatus } from '../dashboard/types.js';
import type { ProgressSession } from '../progress/schema.js';
import type { TranscriptEntry } from '../types.js';

if (!customElements.get('lion-button')) customElements.define('lion-button', LionButton);
if (!customElements.get('lion-checkbox')) customElements.define('lion-checkbox', LionCheckbox);
if (!customElements.get('lion-input')) customElements.define('lion-input', LionInput);

const stages = ['ingest', 'specification', 'implementation', 'verification', 'publish'] as const;

export class HarnessDashboard extends LitElement {
  static styles = css`
    :host {
      --accent: #0b63ce;
      color-scheme: light;
      display: block;
      min-height: 100vh;
      color: #172033;
      background: #f3f6fa;
      font: 16px/1.5 system-ui, sans-serif;
    }
    header { padding: 1.5rem clamp(1rem, 4vw, 3rem); color: white; background: #172033; }
    header h1 { margin: 0; font-size: clamp(1.5rem, 4vw, 2.25rem); }
    header p { margin: .25rem 0 0; color: #ccd5e4; }
    main { display: grid; grid-template-columns: minmax(18rem, 26rem) 1fr; gap: 1.5rem; padding: 1.5rem clamp(1rem, 4vw, 3rem); }
    section { min-width: 0; padding: 1.25rem; border: 1px solid #d7deea; border-radius: .75rem; background: white; box-shadow: 0 2px 8px #17203312; }
    h2 { margin-top: 0; }
    form { display: grid; gap: .75rem; }
    .row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: .75rem; }
    lion-input { width: 100%; min-width: 0; }
    lion-input input {
      width: 100%;
      box-sizing: border-box;
      padding: .45rem .6rem;
      border: 1px solid #b9c4d6;
      border-radius: .35rem;
      font: inherit;
    }
    p[role='status'] { overflow-wrap: anywhere; }
    lion-button { padding: .7rem 1rem; border-radius: .4rem; color: white; background: var(--accent); }
    lion-button[disabled] { opacity: .5; }
    .secondary { color: #172033; background: #e8edf5; }
    .sessions { display: grid; gap: 1rem; }
    article { padding: 1rem; border: 1px solid #d7deea; border-radius: .5rem; }
    article header { display: flex; align-items: center; justify-content: space-between; gap: 1rem; padding: 0; color: inherit; background: none; }
    .status { padding: .2rem .55rem; border-radius: 1rem; font-size: .8rem; font-weight: 700; background: #e8edf5; }
    .status-running { color: #0759a5; background: #dceeff; }
    .status-completed { color: #146c2e; background: #dcf7e4; }
    .status-failed, .status-cancelled, .status-cancelling { color: #a02020; background: #ffe1e1; }
    ol { display: grid; grid-template-columns: repeat(5, 1fr); gap: .35rem; padding: 0; list-style: none; }
    li { padding: .4rem; border-radius: .3rem; text-align: center; font-size: .75rem; background: #edf1f6; }
    li.done { color: white; background: #287a3f; }
    li.current { outline: 2px solid var(--accent); }
    .error { color: #9b1c1c; white-space: pre-wrap; overflow-wrap: anywhere; }
    .empty { color: #596579; }
    .chat { display: grid; gap: .5rem; margin-top: .75rem; padding: .75rem; border: 1px solid #d7deea; border-radius: .5rem; max-height: 26rem; overflow: auto; background: #fafbfd; }
    .msg { max-width: 88%; padding: .5rem .7rem; border-radius: .55rem; font-size: .85rem; white-space: pre-wrap; overflow-wrap: anywhere; }
    .msg-user { justify-self: end; color: #0b2e55; background: #dceeff; }
    .msg-assistant { justify-self: start; background: #eef1f6; }
    .msg-reasoning { justify-self: start; color: #596579; font-style: italic; background: #f4f5f8; }
    .msg-tool { justify-self: start; max-width: 100%; color: #596579; font: .72rem/1.4 ui-monospace, monospace; background: #f6f7f9; }
    .msg header { display: flex; gap: .5rem; justify-content: space-between; margin-bottom: .15rem; padding: 0; font-size: .68rem; font-weight: 700; text-transform: uppercase; color: #596579; background: none; }
    .divider { justify-self: center; padding: .1rem .6rem; border-radius: 1rem; font-size: .7rem; font-weight: 700; color: #0759a5; background: #dceeff; }
    @media (max-width: 850px) {
      main { grid-template-columns: 1fr; }
      .row { grid-template-columns: 1fr; }
      ol { grid-template-columns: 1fr; }
    }
  `;

  static properties = {
    sessions: { state: true },
    observed: { state: true },
    loading: { state: true },
    message: { state: true },
    expanded: { state: true },
    transcript: { state: true },
  };

  declare private sessions: SessionRecord[];
  declare private observed: ProgressSession[];
  declare private loading: boolean;
  declare private message: string;
  declare private expanded: string | undefined;
  declare private transcript: TranscriptEntry[];
  #timer?: number;
  #events: EventSource | undefined;
  #refreshQueued = false;

  constructor() {
    super();
    this.sessions = [];
    this.observed = [];
    this.loading = false;
    this.message = '';
    this.expanded = undefined;
    this.transcript = [];
  }

  connectedCallback(): void {
    super.connectedCallback();
    void this.#refresh();
    this.#subscribe();
  }

  disconnectedCallback(): void {
    this.#events?.close();
    if (this.#timer !== undefined) window.clearInterval(this.#timer);
    super.disconnectedCallback();
  }

  /** Live updates over SSE; falls back to a 2s poll if the stream fails. */
  #subscribe(): void {
    try {
      this.#events = new EventSource('/api/events');
    } catch {
      this.#pollFallback();
      return;
    }
    const scheduleRefresh = () => {
      if (this.#refreshQueued) return;
      this.#refreshQueued = true;
      window.setTimeout(() => {
        this.#refreshQueued = false;
        void this.#refresh();
      }, 150);
    };
    this.#events.addEventListener('snapshot', scheduleRefresh);
    this.#events.addEventListener('progress', scheduleRefresh);
    this.#events.addEventListener('error', () => {
      this.#events?.close();
      this.#events = undefined;
      this.#pollFallback();
    });
  }

  #pollFallback(): void {
    if (this.#timer !== undefined) return;
    this.#timer = window.setInterval(() => void this.#refresh(), 2000);
  }

  render() {
    return html`
      <header>
        <h1>Web Development Harness</h1>
        <p>Deterministic Open-WC workflow sessions</p>
      </header>
      <main>
        <section aria-labelledby="configuration-title">
          <h2 id="configuration-title">New session</h2>
          <form @submit=${this.#start}>
            ${this.#input('workspace', 'Workspace', '.', true)}
            <div class="row">
              ${this.#input('workItemId', 'ADO work item ID', '', true, 'number')}
              ${this.#input('pipelineId', 'Pipeline ID', '', false, 'number')}
            </div>
            ${this.#input('adoOrganization', 'ADO organization or URL', '', true)}
            <div class="row">
              ${this.#input('adoProject', 'ADO project', '', true)}
              ${this.#input('adoRepository', 'ADO repository', '', true)}
            </div>
            <div class="row">
              ${this.#input('sourceBranch', 'Source branch', 'feature/copilot-component')}
              ${this.#input('targetBranch', 'Target branch', 'main')}
            </div>
            ${this.#input('figmaFileKey', 'Figma file key', '', true)}
            ${this.#input('figmaNodeIds', 'Figma node IDs', '')}
            ${this.#input('figmaToken', 'Figma token', '', true, 'password')}
            ${this.#input('openApiPath', 'OpenAPI path', '', true)}
            <div class="row">
              ${this.#input('copilotModel', 'Copilot model', 'gpt-5')}
              ${this.#input('resultFiles', 'Result files', '')}
            </div>
            <lion-checkbox name="skipPublish" label="Skip publish"></lion-checkbox>
            <lion-button type="submit" ?disabled=${this.loading}>
              ${this.loading ? 'Starting…' : 'Start workflow'}
            </lion-button>
            <lion-button type="button" class="secondary" ?disabled=${this.loading} @click=${this.#demo}>
              Run demo (mocked integrations)
            </lion-button>
            <p role="status" aria-live="polite">${this.message}</p>
          </form>
        </section>
        <section aria-labelledby="sessions-title">
          <h2 id="sessions-title">Workflow sessions</h2>
          <div class="sessions" aria-live="polite">
            ${this.sessions.length
              ? this.sessions.map(session => this.#session(session))
              : html`<p class="empty">No sessions have been started.</p>`}
          </div>
          <h2 id="observed-title">Observed agent sessions</h2>
          <div class="sessions" aria-live="polite" aria-labelledby="observed-title">
            ${this.observed.length
              ? this.observed.map(session => this.#observedSession(session))
              : html`<p class="empty">No external agent sessions have reported progress.</p>`}
          </div>
        </section>
      </main>
    `;
  }

  #input(name: string, label: string, placeholder = '', required = false, type = 'text') {
    return html`<lion-input
      name=${name}
      label=${label}
      placeholder=${placeholder}
      type=${type}
      ?required=${required}
    ></lion-input>`;
  }

  #session(session: SessionRecord) {
    const completed = new Set(session.state?.completedStages ?? []);
    return html`
      <article>
        <header>
          <strong>Work item ${session.config.workItemId}</strong>
          <span class="status status-${session.status}">${session.status}</span>
        </header>
        <p>${session.config.adoProject} / ${session.config.adoRepository}</p>
        <ol aria-label="Workflow stages">
          ${stages.map(stage => html`
            <li class=${completed.has(stage) ? 'done' : session.currentStage === stage ? 'current' : ''}>
              ${stage}
            </li>
          `)}
        </ol>
        ${session.attempt ? html`<p>Verification attempt ${session.attempt} of 3</p>` : nothing}
        ${session.error ? html`<p class="error" role="alert">${session.error}</p>` : nothing}
        <lion-button class="secondary" @click=${() => this.#toggleTranscript(session.id)}>
          ${this.expanded === session.id ? 'Hide conversation' : 'Show conversation'}
        </lion-button>
        ${active(session.status) ? html`
          <lion-button class="secondary" @click=${() => this.#cancel(session.id)}>Cancel</lion-button>
        ` : nothing}
        ${this.expanded === session.id ? this.#chat() : nothing}
      </article>
    `;
  }

  /** Observed sessions are external agent runtimes; no stage semantics apply. */
  #observedSession(session: ProgressSession) {
    return html`
      <article>
        <header>
          <strong>${session.title ?? session.externalId ?? session.id}</strong>
          <span class="status status-${session.status}">${session.status}</span>
        </header>
        <p>${session.runtime}${session.externalId ? html` · ${session.externalId}` : nothing}</p>
        ${session.currentStep ? html`<p>Step: ${session.currentStep.name}</p>` : nothing}
        ${session.currentTool ? html`<p class="msg-tool">Tool: ${session.currentTool.name}${session.currentTool.argsSummary ? ` ${session.currentTool.argsSummary}` : ''}</p>` : nothing}
        ${session.errors.length ? html`<p class="error" role="alert">${session.errors[session.errors.length - 1]}</p>` : nothing}
      </article>
    `;
  }

  #chat() {
    if (!this.transcript.length) {
      return html`<div class="chat"><p class="empty">No conversation with Copilot yet.</p></div>`;
    }
    let lastStage: string | undefined;
    return html`<div class="chat" aria-label="Copilot conversation">
      ${this.transcript.map(entry => {
        const divider = entry.stage && entry.stage !== lastStage
          ? html`<span class="divider">${entry.stage}</span>`
          : nothing;
        lastStage = entry.stage ?? lastStage;
        return html`${divider}<div class="msg msg-${entry.role}">
          <header>
            <span>${label(entry.role)}</span>
            <span>${new Date(entry.at).toLocaleTimeString()}</span>
          </header>${entry.content}</div>`;
      })}
    </div>`;
  }

  async #toggleTranscript(id: string): Promise<void> {
    if (this.expanded === id) {
      this.expanded = undefined;
      this.transcript = [];
      return;
    }
    this.expanded = id;
    this.transcript = [];
    await this.#loadTranscript();
  }

  async #loadTranscript(): Promise<void> {
    if (!this.expanded) return;
    try {
      const response = await fetch(`/api/sessions/${this.expanded}`);
      if (response.ok) {
        const record = await response.json() as SessionRecord;
        this.transcript = record.transcript ?? [];
      }
    } catch {
      // Keep the last transcript when a poll fails.
    }
  }

  async #start(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    this.loading = true;
    this.message = '';
    const form = event.currentTarget as HTMLFormElement;
    const fields = Object.fromEntries(
      [...form.querySelectorAll<LionInput>('lion-input')].map(input => [input.name, input.modelValue]),
    );
    const skipPublish = form.querySelector<LionCheckbox>('lion-checkbox')?.checked ?? false;
    const payload = {
      ...fields,
      workItemId: Number(fields.workItemId),
      ...(fields.pipelineId ? { pipelineId: Number(fields.pipelineId) } : {}),
      figmaNodeIds: split(fields.figmaNodeIds),
      resultFiles: split(fields.resultFiles),
      skipPublish,
    };
    try {
      const response = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error ?? 'Unable to start session');
      form.reset();
      this.message = 'Workflow session started.';
      await this.#refresh();
    } catch (error) {
      this.message = error instanceof Error ? error.message : 'Unable to start session';
    } finally {
      this.loading = false;
    }
  }

  async #demo(): Promise<void> {
    this.loading = true;
    this.message = '';
    try {
      const response = await fetch('/api/demo', { method: 'POST' });
      const body = await response.json() as { error?: string; config?: { workspace?: string } };
      if (!response.ok) throw new Error(body.error ?? 'Unable to start demo session');
      this.message = `Demo session started in ${body.config?.workspace ?? 'a temporary workspace'}. Azure, Figma and verification are mocked; Copilot runs for real.`;
      await this.#refresh();
    } catch (error) {
      this.message = error instanceof Error ? error.message : 'Unable to start demo session';
    } finally {
      this.loading = false;
    }
  }

  async #cancel(id: string): Promise<void> {
    await fetch(`/api/sessions/${id}/cancel`, { method: 'POST' });
    await this.#refresh();
  }

  async #refresh(): Promise<void> {
    try {
      const [sessions, progress] = await Promise.all([
        fetch('/api/sessions'),
        fetch('/api/progress/sessions'),
      ]);
      if (sessions.ok) this.sessions = await sessions.json() as SessionRecord[];
      if (progress.ok) {
        const all = await progress.json() as ProgressSession[];
        this.observed = all.filter(session => session.kind === 'observed');
      }
      await this.#loadTranscript();
    } catch {
      this.message ||= 'Dashboard server is unavailable.';
    }
  }
}

function label(role: TranscriptEntry['role']): string {
  if (role === 'user') return 'harness';
  if (role === 'tool') return 'tool call';
  return role;
}

function split(value: unknown): string[] {
  return typeof value === 'string'
    ? value.split(',').map(item => item.trim()).filter(Boolean)
    : [];
}

function active(status: SessionStatus): boolean {
  return status === 'queued' || status === 'running';
}

customElements.define('harness-dashboard', HarnessDashboard);
