import { LitElement, css, html, nothing } from 'lit';
import { LionButton } from '@lion/ui/button.js';
import { LionCheckbox } from '@lion/ui/checkbox-group.js';
import { LionInput } from '@lion/ui/input.js';
import type { SessionRecord, SessionStatus } from '../dashboard/types.js';

if (!customElements.get('lion-button')) customElements.define('lion-button', LionButton);
if (!customElements.get('lion-checkbox')) customElements.define('lion-checkbox', LionCheckbox);
if (!customElements.get('lion-input')) customElements.define('lion-input', LionInput);

const stages = ['ingest', 'specification', 'implementation', 'verification', 'publish'] as const;

export class HarnessDashboard extends LitElement {
  static styles = css`
    :host {
      --accent: #0b63ce;
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
    section { padding: 1.25rem; border: 1px solid #d7deea; border-radius: .75rem; background: white; box-shadow: 0 2px 8px #17203312; }
    h2 { margin-top: 0; }
    form { display: grid; gap: .75rem; }
    .row { display: grid; grid-template-columns: 1fr 1fr; gap: .75rem; }
    lion-input { width: 100%; }
    lion-button { padding: .7rem 1rem; border-radius: .4rem; color: white; background: var(--accent); }
    lion-button[disabled] { opacity: .5; }
    .secondary { color: #172033; background: #e8edf5; }
    .sessions { display: grid; gap: 1rem; }
    article { padding: 1rem; border: 1px solid #d7deea; border-radius: .5rem; }
    article header { display: flex; align-items: center; justify-content: space-between; gap: 1rem; padding: 0; color: inherit; background: none; }
    .status { padding: .2rem .55rem; border-radius: 1rem; font-size: .8rem; font-weight: 700; background: #e8edf5; }
    .status-running { color: #0759a5; background: #dceeff; }
    .status-completed { color: #146c2e; background: #dcf7e4; }
    .status-failed, .status-cancelled { color: #a02020; background: #ffe1e1; }
    ol { display: grid; grid-template-columns: repeat(5, 1fr); gap: .35rem; padding: 0; list-style: none; }
    li { padding: .4rem; border-radius: .3rem; text-align: center; font-size: .75rem; background: #edf1f6; }
    li.done { color: white; background: #287a3f; }
    li.current { outline: 2px solid var(--accent); }
    .error { color: #9b1c1c; white-space: pre-wrap; }
    .empty { color: #596579; }
    @media (max-width: 850px) {
      main { grid-template-columns: 1fr; }
      .row { grid-template-columns: 1fr; }
      ol { grid-template-columns: 1fr; }
    }
  `;

  static properties = {
    sessions: { state: true },
    loading: { state: true },
    message: { state: true },
  };

  declare private sessions: SessionRecord[];
  declare private loading: boolean;
  declare private message: string;
  #timer?: number;

  constructor() {
    super();
    this.sessions = [];
    this.loading = false;
    this.message = '';
  }

  connectedCallback(): void {
    super.connectedCallback();
    void this.#refresh();
    this.#timer = window.setInterval(() => void this.#refresh(), 2000);
  }

  disconnectedCallback(): void {
    if (this.#timer !== undefined) window.clearInterval(this.#timer);
    super.disconnectedCallback();
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
        ${active(session.status) ? html`
          <lion-button class="secondary" @click=${() => this.#cancel(session.id)}>Cancel</lion-button>
        ` : nothing}
      </article>
    `;
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

  async #cancel(id: string): Promise<void> {
    await fetch(`/api/sessions/${id}/cancel`, { method: 'POST' });
    await this.#refresh();
  }

  async #refresh(): Promise<void> {
    try {
      const response = await fetch('/api/sessions');
      if (response.ok) this.sessions = await response.json() as SessionRecord[];
    } catch {
      this.message ||= 'Dashboard server is unavailable.';
    }
  }
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
