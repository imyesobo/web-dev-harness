import { LitElement, css, html, nothing } from 'lit';
import { keyed } from 'lit/directives/keyed.js';
import { repeat } from 'lit/directives/repeat.js';
import { LionButton } from '@lion/ui/button.js';
import { LionCheckbox } from '@lion/ui/checkbox-group.js';
import { LionInput } from '@lion/ui/input.js';
import type { SessionRecord, SessionStatus } from '../dashboard/types.js';
import type { HumanInputRequest, StepStatus, TranscriptEntry } from '../types.js';
import { costSummary, executorLabel, stepDefinition, workflowSteps } from '../workflow.js';

if (!customElements.get('lion-button')) customElements.define('lion-button', LionButton);
if (!customElements.get('lion-checkbox')) customElements.define('lion-checkbox', LionCheckbox);
if (!customElements.get('lion-input')) customElements.define('lion-input', LionInput);

const stepIcons: Record<StepStatus, string> = {
  completed: '✓',
  running: '⏳',
  waiting_for_human: '⏸',
  pending: '□',
};

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
    .status-waiting_for_human { color: #7a4b00; background: #fff1d6; }
    .status-completed { color: #146c2e; background: #dcf7e4; }
    .status-failed, .status-cancelled, .status-cancelling { color: #a02020; background: #ffe1e1; }
    ol.steps { display: grid; gap: .35rem; padding: 0; list-style: none; }
    ol.steps li { display: grid; grid-template-columns: 1.5rem 1fr auto; align-items: center; gap: .5rem; padding: .4rem .6rem; border-radius: .3rem; font-size: .85rem; background: #edf1f6; }
    ol.steps li.completed .icon { color: #287a3f; }
    ol.steps li.running { outline: 2px solid var(--accent); }
    ol.steps li.waiting_for_human { outline: 2px solid #d48a00; background: #fff8e8; }
    .icon { font-weight: 700; text-align: center; }
    .executor { padding: .1rem .5rem; border-radius: 1rem; font-size: .72rem; font-weight: 700; white-space: nowrap; }
    .executor-human, .executor-human-m365 { color: #7a4b00; background: #fff1d6; }
    .executor-github-agent { color: #0759a5; background: #dceeff; }
    .executor-tool { color: #3d4a5c; background: #e3e7ee; }
    .hub { display: grid; grid-template-columns: 1fr auto 1.2fr auto 1fr; align-items: center; gap: .4rem; margin: .75rem 0; text-align: center; font-size: .78rem; }
    .hub div { padding: .5rem; border-radius: .5rem; border: 1px solid #d7deea; }
    .hub .state { color: white; background: #172033; font-weight: 700; }
    .hub .state small { display: block; font-weight: 400; color: #ccd5e4; }
    .hub .arrow { font-size: 1.2rem; color: #596579; }
    .human-input { display: grid; gap: .5rem; margin: .75rem 0; padding: .75rem; border: 2px solid #d48a00; border-radius: .5rem; background: #fffaf0; }
    .human-input h3 { margin: 0; font-size: 1rem; }
    .human-input label { display: grid; gap: .2rem; font-size: .85rem; font-weight: 600; }
    textarea, select { font: inherit; font-size: .85rem; padding: .4rem; border: 1px solid #b9c4d6; border-radius: .35rem; }
    textarea { min-height: 4rem; resize: vertical; }
    textarea[readonly] { min-height: 8rem; font: .72rem/1.4 ui-monospace, monospace; background: #f6f7f9; }
    fieldset { display: grid; gap: .5rem; border: 1px solid #d7deea; border-radius: .5rem; }
    fieldset label { display: grid; grid-template-columns: 1fr 1fr; align-items: center; gap: .5rem; font-size: .85rem; }
    dl.cost { display: grid; grid-template-columns: repeat(auto-fit, minmax(8rem, 1fr)); gap: .4rem; margin: .5rem 0; }
    dl.cost div { padding: .4rem; border-radius: .35rem; background: #f4f6fa; }
    dl.cost dt { font-size: .7rem; color: #596579; }
    dl.cost dd { margin: 0; font-weight: 700; }
    .history { font-size: .8rem; }
    .history ol { padding-left: 1.2rem; }
    .error { color: #9b1c1c; white-space: pre-wrap; overflow-wrap: anywhere; }
    .empty { color: #596579; }
    .chat { display: grid; gap: .5rem; margin-top: .75rem; padding: .75rem; border: 1px solid #d7deea; border-radius: .5rem; max-height: 26rem; overflow: auto; background: #fafbfd; }
    .msg { max-width: 88%; padding: .5rem .7rem; border-radius: .55rem; font-size: .85rem; white-space: pre-wrap; overflow-wrap: anywhere; }
    .msg-user { justify-self: end; color: #0b2e55; background: #dceeff; }
    .msg-assistant { justify-self: start; background: #eef1f6; }
    .msg-reasoning { justify-self: start; color: #596579; font-style: italic; background: #f4f5f8; }
    .msg-tool { justify-self: start; max-width: 100%; color: #596579; font: .72rem/1.4 ui-monospace, monospace; background: #f6f7f9; }
    .msg-human { justify-self: end; color: #5c3900; background: #fff1d6; }
    .msg header { display: flex; gap: .5rem; justify-content: space-between; margin-bottom: .15rem; padding: 0; font-size: .68rem; font-weight: 700; text-transform: uppercase; color: #596579; background: none; }
    .divider { justify-self: center; padding: .1rem .6rem; border-radius: 1rem; font-size: .7rem; font-weight: 700; color: #0759a5; background: #dceeff; }
    @media (max-width: 850px) {
      main { grid-template-columns: 1fr; }
      .row { grid-template-columns: 1fr; }
      .hub { grid-template-columns: 1fr; }
    }
  `;

  static properties = {
    sessions: { state: true },
    loading: { state: true },
    message: { state: true },
    expanded: { state: true },
    transcript: { state: true },
  };

  declare private sessions: SessionRecord[];
  declare private loading: boolean;
  declare private message: string;
  declare private expanded: string | undefined;
  declare private transcript: TranscriptEntry[];
  #timer?: number;

  constructor() {
    super();
    this.sessions = [];
    this.loading = false;
    this.message = '';
    this.expanded = undefined;
    this.transcript = [];
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
            <fieldset>
              <legend>Step executors</legend>
              ${workflowSteps.filter(step => step.executors.length > 1).map(step => html`
                <label>${step.title}
                  <select data-step=${step.id}>
                    ${step.executors.map(executor => html`
                      <option value=${executor} ?selected=${executor === step.defaultExecutor}>
                        ${executorLabel(executor)}
                      </option>
                    `)}
                  </select>
                </label>
              `)}
            </fieldset>
            <lion-button type="submit" ?disabled=${this.loading}>
              ${this.loading ? 'Starting…' : 'Start workflow'}
            </lion-button>
            <lion-button type="button" class="secondary" ?disabled=${this.loading} @click=${() => this.#demo(false)}>
              Run autonomous demo (mocked integrations)
            </lion-button>
            <lion-button type="button" class="secondary" ?disabled=${this.loading} @click=${() => this.#demo(true)}>
              Run hybrid demo (Human + M365 Copilot analysis)
            </lion-button>
            <p role="status" aria-live="polite">${this.message}</p>
          </form>
        </section>
        <section aria-labelledby="sessions-title">
          <h2 id="sessions-title">Workflow sessions</h2>
          <div class="sessions" aria-live="polite">
            ${this.sessions.length
              ? repeat(this.sessions, session => session.id, session => this.#session(session))
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
    const executors = session.config.executors;
    const steps = session.state?.steps ?? {};
    const cost = costSummary(executors, session.state);
    const completedCount = session.state?.completedStages.length ?? 0;
    return html`
      <article>
        <header>
          <strong>Work item ${session.config.workItemId}</strong>
          <span class="status status-${session.status}">${statusLabel(session.status)}</span>
        </header>
        <p>${session.config.adoProject} / ${session.config.adoRepository}</p>
        <div class="hub" aria-label="Executors write to the shared workflow state">
          <div>Human + M365 Copilot<br><small>${cost.humanSteps} steps</small></div>
          <span class="arrow" aria-hidden="true">→</span>
          <div class="state">Workflow State
            <small>${completedCount}/${workflowSteps.length} steps · ${statusLabel(session.status)}</small>
          </div>
          <span class="arrow" aria-hidden="true">←</span>
          <div>GitHub Agent + Tools<br><small>${cost.agentSteps} agent · ${cost.toolSteps} tool</small></div>
        </div>
        <ol class="steps" aria-label="Workflow steps">
          ${workflowSteps.map(step => {
            const status = steps[step.id]?.status ?? 'pending';
            const executor = steps[step.id]?.executor ?? executors[step.id];
            return html`
              <li class=${status}>
                <span class="icon" aria-hidden="true">${stepIcons[status]}</span>
                <span>${step.title}${status === 'waiting_for_human' ? html` — <em>Waiting for input</em>` : nothing}</span>
                <span class="executor executor-${executor}">Executor: ${executorLabel(executor)}</span>
              </li>
            `;
          })}
        </ol>
        ${session.pendingInput ? keyed(session.pendingInput.stepId, this.#humanInput(session.id, session.pendingInput)) : nothing}
        ${session.attempt ? html`<p>Verification attempt ${session.attempt} of 3</p>` : nothing}
        ${session.error ? html`<p class="error" role="alert">${session.error}</p>` : nothing}
        <dl class="cost" aria-label="Workflow cost summary">
          <div><dt>Human assisted steps</dt><dd>${cost.humanSteps}</dd></div>
          <div><dt>Agent steps</dt><dd>${cost.agentSteps}</dd></div>
          <div><dt>Tool steps</dt><dd>${cost.toolSteps}</dd></div>
          <div><dt>Est. Copilot calls</dt><dd>${cost.estimatedCopilotCalls}</dd></div>
          <div><dt>Copilot calls so far</dt><dd>${cost.copilotCalls}</dd></div>
          <div><dt>Agent calls avoided</dt><dd>${cost.agentCallsAvoided}</dd></div>
        </dl>
        ${session.state?.history.length ? html`
          <details class="history">
            <summary>Execution history (${session.state.history.length})</summary>
            <ol>
              ${session.state.history.map(entry => html`<li>
                ${new Date(entry.at).toLocaleTimeString()} · ${stepDefinition(entry.stepId).title}
                · ${executorLabel(entry.executor)} · ${historyLabel(entry.event)}
              </li>`)}
            </ol>
          </details>
        ` : nothing}
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

  #humanInput(sessionId: string, request: HumanInputRequest) {
    return html`
      <form class="human-input" @submit=${(event: SubmitEvent) => this.#submitHuman(event, sessionId, request)}>
        <h3>Waiting for input: ${request.title}</h3>
        <p>Executor: ${executorLabel(request.executor)}. ${request.instructions}</p>
        <label>Briefing to paste into Microsoft 365 Copilot
          <textarea readonly .value=${request.briefing}></textarea>
        </label>
        <lion-button type="button" class="secondary" @click=${() => void navigator.clipboard.writeText(request.briefing)}>
          Copy briefing
        </lion-button>
        ${request.fields.map(field => html`
          <label>${field.label}${field.kind === 'list' ? ' (one per line)' : ''}
            <textarea name=${field.name} ?required=${field.required ?? false}></textarea>
          </label>
        `)}
        <lion-button type="submit">Submit outputs and resume workflow</lion-button>
      </form>
    `;
  }

  async #submitHuman(event: SubmitEvent, sessionId: string, request: HumanInputRequest): Promise<void> {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const outputs = Object.fromEntries(request.fields.map(field => {
      const value = form.querySelector<HTMLTextAreaElement>(`textarea[name="${field.name}"]`)?.value ?? '';
      return [field.name, field.kind === 'list' ? value.split('\n').map(line => line.trim()).filter(Boolean) : value];
    }));
    try {
      const response = await fetch(`/api/sessions/${sessionId}/steps/${request.stepId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ outputs }),
      });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error ?? 'Unable to submit outputs');
      this.message = `${request.title} completed. Workflow resumed.`;
      await this.#refresh();
    } catch (error) {
      this.message = error instanceof Error ? error.message : 'Unable to submit outputs';
    }
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
    const executors = Object.fromEntries(
      [...form.querySelectorAll<HTMLSelectElement>('select[data-step]')]
        .map(select => [select.dataset.step, select.value]),
    );
    const payload = {
      ...fields,
      workItemId: Number(fields.workItemId),
      ...(fields.pipelineId ? { pipelineId: Number(fields.pipelineId) } : {}),
      figmaNodeIds: split(fields.figmaNodeIds),
      resultFiles: split(fields.resultFiles),
      skipPublish,
      executors,
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

  async #demo(hybrid: boolean): Promise<void> {
    this.loading = true;
    this.message = '';
    try {
      const response = await fetch(`/api/demo${hybrid ? '?mode=hybrid' : ''}`, { method: 'POST' });
      const body = await response.json() as { error?: string; config?: { workspace?: string } };
      if (!response.ok) throw new Error(body.error ?? 'Unable to start demo session');
      this.message = `Demo session started in ${body.config?.workspace ?? 'a temporary workspace'}. Azure, Figma and verification are mocked; Copilot runs for real.${hybrid ? ' Analysis steps will wait for your input.' : ''}`;
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
      const response = await fetch('/api/sessions');
      if (response.ok) this.sessions = await response.json() as SessionRecord[];
      await this.#loadTranscript();
    } catch {
      this.message ||= 'Dashboard server is unavailable.';
    }
  }
}

function label(role: TranscriptEntry['role']): string {
  if (role === 'user') return 'harness';
  if (role === 'tool') return 'tool call';
  if (role === 'human') return 'human output';
  return role;
}

function statusLabel(status: SessionStatus): string {
  return status === 'waiting_for_human' ? 'Waiting for input' : status;
}

function historyLabel(event: string): string {
  if (event === 'waiting_for_human') return 'waiting for input';
  if (event === 'resumed') return 'outputs received, workflow resumed';
  return event;
}

function split(value: unknown): string[] {
  return typeof value === 'string'
    ? value.split(',').map(item => item.trim()).filter(Boolean)
    : [];
}

function active(status: SessionStatus): boolean {
  return status === 'queued' || status === 'running' || status === 'waiting_for_human';
}

customElements.define('harness-dashboard', HarnessDashboard);
