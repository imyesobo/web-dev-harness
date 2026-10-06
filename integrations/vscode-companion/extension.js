// Web Dev Harness companion: a light VS Code surface over the local harness
// backend. It shows the most recent active session in the status bar and
// deep-links into the web dashboard. It deliberately does not modify the
// official Copilot chat panel — the web UI is the canonical progress surface.
'use strict';

const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');

const POLL_INTERVAL_MS = 3000;

function discoveryFile() {
  const directory = process.env.HARNESS_DATA_DIR || path.join(os.homedir(), '.web-dev-harness');
  return path.join(directory, 'harness.json');
}

function readDiscovery() {
  try {
    return JSON.parse(fs.readFileSync(discoveryFile(), 'utf8'));
  } catch {
    return undefined;
  }
}

function activate(context) {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  item.command = 'webDevHarness.open';
  context.subscriptions.push(item);

  let dashboardUrl;

  context.subscriptions.push(vscode.commands.registerCommand('webDevHarness.open', () => {
    const discovery = readDiscovery();
    const target = (discovery && discovery.url) || dashboardUrl;
    if (target) void vscode.env.openExternal(vscode.Uri.parse(target));
    else void vscode.window.showInformationMessage('The web-dev-harness dashboard is not running. Start it with `npm run dashboard`.');
  }));

  async function refresh() {
    const discovery = readDiscovery();
    if (!discovery || !discovery.url) {
      item.hide();
      return;
    }
    dashboardUrl = discovery.url;
    try {
      const response = await fetch(`${discovery.url}/api/progress/sessions`);
      if (!response.ok) throw new Error(String(response.status));
      const sessions = await response.json();
      const active = sessions.find(session => session.status === 'running' || session.status === 'waiting');
      const latest = active || sessions[0];
      if (!latest) {
        item.text = '$(pulse) Harness: idle';
        item.tooltip = 'Open the web-dev-harness dashboard';
      } else {
        const step = latest.currentStep ? ` · ${latest.currentStep.name}` : '';
        item.text = `$(pulse) Harness: ${latest.status}${step}`;
        item.tooltip = `${latest.title || latest.runtime} — click to open the dashboard`;
        if (latest.url) item.command = { command: 'webDevHarness.open', title: 'Open' };
      }
      item.show();
    } catch {
      item.hide();
    }
  }

  const timer = setInterval(() => void refresh(), POLL_INTERVAL_MS);
  context.subscriptions.push({ dispose: () => clearInterval(timer) });
  void refresh();
}

function deactivate() {}

module.exports = { activate, deactivate };
