import * as vscode from "vscode";
import { formatErrorForUi, getBcp47Locale, t } from "./i18n";
import { loadLocaleDict, webviewI18nBootstrap } from "./i18n/webviewLocale";
import { Client } from "pg";
import {
  ConnectionActivityLog,
} from "./connectionActivityLog";
import { ConnectionNodeRef, PostgresConnection } from "./models";
import { requirePostgresConnection } from "./connectionIdentity";
import {
  ManagerDashboardSnapshot,
  ManagerStatCounters,
  PostgresService,
} from "./postgresService";

type ManagerSection = "log" | "dashboard" | "processes";

type ManagerWebviewMessage =
  | { type: "ready" }
  | { type: "setSection"; section: ManagerSection }
  | { type: "setPollInterval"; seconds: number }
  | { type: "setTimeWindow"; minutes: number }
  | { type: "terminate"; pid: number };

interface ChartPoint {
  t: number;
  label: string;
  readKb: number | null;
  hitKb: number | null;
  insert: number | null;
  update: number | null;
  delete: number | null;
  select: number | null;
  fetched: number | null;
  xactCommit: number | null;
  xactRollback: number | null;
  sessionsTotal: number | null;
  sessionsActive: number | null;
  sessionsIdle: number | null;
}

const MANAGER_POLL_SETTING = "dbadmin.managerPollIntervalSeconds";
const MANAGER_WINDOW_SETTING = "dbadmin.managerTimeWindowMinutes";
const UNLIMITED_SEED_POINTS = 60;

function emptyChartPoint(t: number, label = ""): ChartPoint {
  return {
    t,
    label,
    readKb: null,
    hitKb: null,
    insert: null,
    update: null,
    delete: null,
    select: null,
    fetched: null,
    xactCommit: null,
    xactRollback: null,
    sessionsTotal: null,
    sessionsActive: null,
    sessionsIdle: null,
  };
}

function isNullChartPoint(point: ChartPoint | undefined): boolean {
  if (!point) {
    return true;
  }
  return (
    point.readKb == null &&
    point.hitKb == null &&
    point.insert == null &&
    point.update == null &&
    point.delete == null &&
    point.select == null &&
    point.fetched == null &&
    point.xactCommit == null &&
    point.xactRollback == null &&
    point.sessionsTotal == null &&
    point.sessionsActive == null &&
    point.sessionsIdle == null
  );
}

function refreshSeriesLabels(_series: ChartPoint[]): void {
  // X-axis labels are computed in the webview from the configured interval/window.
}

function clampPollSeconds(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 2;
  }
  return Math.max(1, Math.min(60, Math.trunc(numeric)));
}

function clampTimeWindowMinutes(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 2;
  }
  return Math.max(0, Math.min(1440, Math.trunc(numeric)));
}

function seriesCapacity(windowMinutes: number, intervalSeconds: number): number {
  if (windowMinutes <= 0) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.max(
    2,
    Math.ceil((windowMinutes * 60) / Math.max(1, intervalSeconds)),
  );
}

function seedEmptySeries(
  intervalSeconds: number,
  windowMinutes: number,
): ChartPoint[] {
  const cap = seriesCapacity(windowMinutes, intervalSeconds);
  const count = Number.isFinite(cap) ? cap : UNLIMITED_SEED_POINTS;
  const step = Math.max(1, intervalSeconds) * 1000;
  const now = Date.now();
  const points: ChartPoint[] = [];
  for (let i = 0; i < count; i += 1) {
    const t = now - (count - 1 - i) * step;
    points.push(emptyChartPoint(t));
  }
  return points;
}

function getManagerPollIntervalSeconds(): number {
  return clampPollSeconds(
    vscode.workspace.getConfiguration().get<number>(MANAGER_POLL_SETTING, 2),
  );
}

function getManagerTimeWindowMinutes(): number {
  return clampTimeWindowMinutes(
    vscode.workspace.getConfiguration().get<number>(MANAGER_WINDOW_SETTING, 2),
  );
}

export class ConnectionManagerPanelManager {
  private readonly panels = new Map<string, vscode.WebviewPanel>();
  private readonly unsubscribeLog: () => void;

  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly postgresService: PostgresService,
    private readonly activityLog: ConnectionActivityLog,
  ) {
    this.unsubscribeLog = this.activityLog.onEntry((entry) => {
      const panel = this.panels.get(entry.connectionId);
      if (!panel) {
        return;
      }
      panel.webview.postMessage({ type: "logEntry", entry });
    });
  }

  public dispose(): void {
    this.unsubscribeLog();
  }

  public show(connection: PostgresConnection): void {
    const key = connection.id;
    const existing = this.panels.get(key);
    if (existing) {
      existing.reveal(vscode.ViewColumn.Active, false);
      return;
    }

    const title =
      connection.nickname?.trim() ||
      connection.database ||
      connection.host ||
      t("Connection");

    const panel = vscode.window.createWebviewPanel(
      "dbadmin.connectionManager",
      t("Manage — {0}", title),
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      { enableScripts: true, retainContextWhenHidden: true },
    );

    panel.iconPath = new vscode.ThemeIcon("settings");
    const initialPollSeconds = getManagerPollIntervalSeconds();
    const initialWindowMinutes = getManagerTimeWindowMinutes();
    panel.webview.html = buildManagerHtml(
      panel.webview,
      this.context.extensionUri,
      this.context.extensionPath,
      connection,
      initialPollSeconds,
      initialWindowMinutes,
    );
    this.panels.set(key, panel);

    let section: ManagerSection = "dashboard";
    let client: Client | null = null;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    let pollInFlight = false;
    let disposed = false;
    let pollSeconds = initialPollSeconds;
    let pendingPollSeconds: number | null = null;
    let windowMinutes = initialWindowMinutes;
    let prevCounters: ManagerStatCounters | null = null;
    let series: ChartPoint[] = seedEmptySeries(
      initialPollSeconds,
      initialWindowMinutes,
    );

    const ensureClient = async (): Promise<Client> => {
      if (client) {
        return client;
      }
      client = await this.postgresService.connectClient(connection);
      client.on("error", () => {
        void client?.end().catch(() => undefined);
        client = null;
      });
      return client;
    };

    const stopPoll = (): void => {
      if (pollTimer) {
        clearTimeout(pollTimer);
        pollTimer = undefined;
      }
    };

    const applyPendingPollSeconds = (): void => {
      if (pendingPollSeconds == null) {
        return;
      }
      pollSeconds = pendingPollSeconds;
      pendingPollSeconds = null;
      const cap = seriesCapacity(windowMinutes, pollSeconds);
      if (Number.isFinite(cap)) {
        while (series.length > cap) {
          series.shift();
        }
        refreshSeriesLabels(series);
      }
      panel.webview.postMessage({ type: "pollInterval", seconds: pollSeconds });
    };

    const pushLogSnapshot = (): void => {
      panel.webview.postMessage({
        type: "logSnapshot",
        entries: this.activityLog.getEntries(connection.id),
      });
    };

    const pushDashboard = async (): Promise<void> => {
      const active = await ensureClient();
      const snapshot = await this.postgresService.getManagerDashboardSnapshot(
        active,
        connection,
      );
      appendSeries(snapshot);
      panel.webview.postMessage({
        type: "dashboard",
        dashboard: {
          server: snapshot.server,
          series,
          sampledAt: snapshot.sampledAt,
        },
      });
    };

    const appendSeries = (snapshot: ManagerDashboardSnapshot): void => {
      const counters = snapshot.counters;
      if (!counters) {
        return;
      }
      const now = Date.parse(snapshot.sampledAt) || Date.now();
      if (!prevCounters) {
        // Baseline only — keep the prefilled null window so X scale stays full.
        prevCounters = counters;
        return;
      }

      const deltaRead = Math.max(0, counters.blksRead - prevCounters.blksRead);
      const deltaHit = Math.max(0, counters.blksHit - prevCounters.blksHit);
      series.push({
        t: now,
        label: "",
        readKb: deltaRead * 8,
        hitKb: deltaHit * 8,
        insert: Math.max(0, counters.tupInserted - prevCounters.tupInserted),
        update: Math.max(0, counters.tupUpdated - prevCounters.tupUpdated),
        delete: Math.max(0, counters.tupDeleted - prevCounters.tupDeleted),
        select: Math.max(0, counters.tupReturned - prevCounters.tupReturned),
        fetched: Math.max(0, counters.tupFetched - prevCounters.tupFetched),
        xactCommit: Math.max(0, counters.xactCommit - prevCounters.xactCommit),
        xactRollback: Math.max(0, counters.xactRollback - prevCounters.xactRollback),
        sessionsTotal: counters.sessionsTotal,
        sessionsActive: counters.sessionsActive,
        sessionsIdle: counters.sessionsIdle,
      });
      prevCounters = counters;

      const cap = seriesCapacity(windowMinutes, pollSeconds);
      if (Number.isFinite(cap)) {
        while (series.length > cap) {
          series.shift();
        }
      } else if (isNullChartPoint(series[0])) {
        // Unlimited: consume one seed placeholder per sample, then grow forever.
        series.shift();
      }

      refreshSeriesLabels(series);
    };

    const pushProcesses = async (): Promise<void> => {
      const active = await ensureClient();
      const processes = await this.postgresService.listConnectionProcesses(
        connection,
        active,
      );
      panel.webview.postMessage({ type: "processes", processes });
    };

    const tick = async (): Promise<void> => {
      if (disposed || pollInFlight || !panel.visible) {
        return;
      }
      pollInFlight = true;
      try {
        if (section === "dashboard") {
          await pushDashboard();
        } else if (section === "processes") {
          await pushProcesses();
        }
      } catch (error) {
        panel.webview.postMessage({
          type: "error",
          message: error instanceof Error ? error.message : String(error),
        });
        try {
          await client?.end();
        } catch {
          // ignore
        }
        client = null;
      } finally {
        pollInFlight = false;
      }
    };

    const scheduleNextPoll = (): void => {
      stopPoll();
      if (disposed || !panel.visible) {
        return;
      }
      pollTimer = setTimeout(() => {
        void (async () => {
          await tick();
          // Apply a pending interval only after the current cycle finishes.
          applyPendingPollSeconds();
          scheduleNextPoll();
        })();
      }, pollSeconds * 1000);
    };

    const startPoll = (): void => {
      stopPoll();
      if (!panel.visible) {
        return;
      }
      void (async () => {
        await tick();
        applyPendingPollSeconds();
        scheduleNextPoll();
      })();
    };

    panel.webview.onDidReceiveMessage(async (message: ManagerWebviewMessage) => {
      if (message.type === "ready") {
        pushLogSnapshot();
        panel.webview.postMessage({ type: "section", section });
        panel.webview.postMessage({
          type: "pollInterval",
          seconds: pollSeconds,
        });
        panel.webview.postMessage({
          type: "timeWindow",
          minutes: windowMinutes,
        });
        startPoll();
        return;
      }

      if (message.type === "setPollInterval") {
        const next = clampPollSeconds(message.seconds);
        pendingPollSeconds = next;
        await vscode.workspace
          .getConfiguration()
          .update(MANAGER_POLL_SETTING, next, vscode.ConfigurationTarget.Global);
        // Do not restart the timer — wait for the current cycle to finish.
        return;
      }

      if (message.type === "setTimeWindow") {
        const next = clampTimeWindowMinutes(message.minutes);
        windowMinutes = next;
        panel.webview.postMessage({ type: "timeWindow", minutes: next });
        await vscode.workspace
          .getConfiguration()
          .update(MANAGER_WINDOW_SETTING, next, vscode.ConfigurationTarget.Global);
        const cap = seriesCapacity(windowMinutes, pollSeconds);
        if (Number.isFinite(cap)) {
          while (series.length > cap) {
            series.shift();
          }
          if (series.length < cap) {
            // Re-seed only when empty/baseline; otherwise keep history and pad left with nulls.
            if (series.every(isNullChartPoint)) {
              series = seedEmptySeries(pollSeconds, windowMinutes);
              prevCounters = null;
            } else {
              const step = Math.max(1, pollSeconds) * 1000;
              const firstT = series[0]?.t ?? Date.now();
              while (series.length < cap) {
                const t = firstT - (cap - series.length) * step;
                series.unshift(emptyChartPoint(t));
              }
            }
          }
          refreshSeriesLabels(series);
        }
        if (section === "dashboard") {
          await tick();
        }
        return;
      }

      if (message.type === "setSection") {
        const next = normalizeSection(message.section);
        section = next;
        panel.webview.postMessage({ type: "section", section });
        if (section === "log") {
          pushLogSnapshot();
        } else {
          await tick();
        }
        return;
      }

      if (message.type === "terminate") {
        const pid = Number(message.pid);
        if (!Number.isFinite(pid) || pid <= 0) {
          return;
        }
        const terminateLabel = t("Terminate");
        const confirm = await vscode.window.showWarningMessage(
          t("Terminate backend PID {0}?", pid),
          { modal: true },
          terminateLabel,
        );
        if (confirm !== terminateLabel) {
          return;
        }
        try {
          const active = await ensureClient();
          const ok = await this.postgresService.terminateConnectionBackend(
            connection,
            pid,
            active,
          );
          if (!ok) {
            vscode.window.showWarningMessage(
              t("Could not terminate PID {0}.", pid),
            );
          }
          await pushProcesses();
        } catch (error) {
          vscode.window.showErrorMessage(formatErrorForUi(error));
        }
      }
    });

    panel.onDidChangeViewState(() => {
      if (disposed) {
        return;
      }
      if (panel.visible) {
        startPoll();
      } else {
        stopPoll();
      }
    });

    panel.onDidDispose(() => {
      disposed = true;
      stopPoll();
      this.panels.delete(key);
      void client?.end().catch(() => undefined);
      client = null;
    });
  }

  public showFromNode(node: ConnectionNodeRef): void {
    if (!node || node.type !== "connection") {
      return;
    }
    this.show(requirePostgresConnection(node.connection));
  }
}

function normalizeSection(value: string | undefined): ManagerSection {
  if (value === "log" || value === "processes") {
    return value;
  }
  return "dashboard";
}

function formatClock(ms: number): string {
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function buildManagerHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  extensionPath: string,
  connection: PostgresConnection,
  pollSeconds: number,
  timeWindowMinutes: number,
): string {
  const nonce = String(Date.now());
  const safePollSeconds = clampPollSeconds(pollSeconds);
  const safeWindowMinutes = clampTimeWindowMinutes(timeWindowMinutes);
  const codiconsCssUri = webview.asWebviewUri(
    vscode.Uri.joinPath(
      extensionUri,
      "node_modules",
      "@vscode",
      "codicons",
      "dist",
      "codicon.css",
    ),
  );
  const csp = `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';`;
  const label =
    connection.nickname?.trim() ||
    `${connection.host}:${connection.port}/${connection.database}`;
  const i18n = loadLocaleDict(extensionPath);
  const i18nScript = webviewI18nBootstrap(extensionPath);
  const i18nLang = getBcp47Locale();
  const L = (key: string, fallback: string) =>
    escapeHtml(i18n[key] || fallback);

  return `<!DOCTYPE html>
<html lang="${i18nLang}">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${codiconsCssUri}" rel="stylesheet" />
  <script nonce="${nonce}">${i18nScript}</script>
  <style>
    html, body { height: 100%; margin: 0; }
    :root { --dbadmin-input-focus: #007acc; accent-color: var(--dbadmin-input-focus); }
    input, textarea, select {
      accent-color: var(--dbadmin-input-focus);
      caret-color: var(--vscode-editorCursor-foreground, var(--dbadmin-input-focus));
    }
    input:focus, textarea:focus, select:focus,
    input:focus-visible, textarea:focus-visible, select:focus-visible {
      outline: none;
      border-color: var(--dbadmin-input-focus);
    }
    input:-webkit-autofill,
    input:-webkit-autofill:hover,
    input:-webkit-autofill:focus {
      -webkit-text-fill-color: var(--vscode-input-foreground);
      caret-color: var(--dbadmin-input-focus);
      box-shadow: 0 0 0 1000px var(--vscode-input-background) inset;
      border-color: var(--dbadmin-input-focus);
    }
    body {
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      display: flex;
      flex-direction: column;
      min-height: 100%;
    }
    .main { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; }
    .toolbar {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 10px 14px;
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    .toolbar .spacer { flex: 1; }
    .toolbar .conn-label {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .toolbar .conn-label .section-item-icon {
      color: var(--vscode-icon-foreground, var(--vscode-descriptionForeground));
    }
    .toolbar .conn-label-text {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .section-select-wrap {
      position: relative;
      display: inline-flex;
      align-items: center;
      flex: 0 0 auto;
      z-index: 5;
    }
    .section-trigger {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      margin: 0;
      padding: 4px 2px 6px 0;
      border: none;
      border-bottom: 2px solid color-mix(in srgb, var(--vscode-foreground) 55%, transparent);
      background: transparent;
      color: var(--vscode-foreground);
      font: inherit;
      font-weight: 600;
      font-size: 13px;
      line-height: 1.3;
      cursor: pointer;
      min-width: 108px;
    }
    .section-trigger:hover {
      border-bottom-color: var(--vscode-foreground);
    }
    .section-trigger:focus-visible {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: 2px;
    }
    .section-trigger[aria-expanded="true"] {
      border-bottom-color: var(--vscode-foreground);
    }
    .section-trigger-label {
      flex: 1 1 auto;
      text-align: left;
    }
    .section-item-icon {
      display: inline-flex;
      width: 16px;
      min-width: 16px;
      height: 16px;
      justify-content: center;
      align-items: center;
      flex: 0 0 auto;
      color: var(--vscode-icon-foreground, var(--vscode-foreground));
    }
    .section-item-icon .codicon {
      font-size: 16px;
      line-height: 1;
      width: 16px;
      height: 16px;
    }
    .section-trigger-icon {
      color: var(--vscode-icon-foreground, var(--vscode-foreground));
    }
    .section-trigger-chevron {
      width: 0;
      height: 0;
      border-left: 4px solid transparent;
      border-right: 4px solid transparent;
      border-top: 4px solid var(--vscode-descriptionForeground);
      transition: transform 120ms ease;
      flex: 0 0 auto;
    }
    .section-trigger[aria-expanded="true"] .section-trigger-chevron {
      transform: rotate(180deg);
    }
    .section-menu {
      position: absolute;
      top: calc(100% + 6px);
      left: 0;
      min-width: 148px;
      margin: 0;
      padding: 4px;
      list-style: none;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
      box-shadow: 0 6px 18px color-mix(in srgb, #000 22%, transparent);
      display: none;
    }
    .section-menu.open {
      display: block;
    }
    .section-menu button {
      display: flex;
      align-items: center;
      gap: 6px;
      width: 100%;
      margin: 0;
      padding: 7px 10px;
      border: none;
      border-radius: 4px;
      background: transparent;
      color: var(--vscode-foreground);
      font: inherit;
      font-size: 12px;
      text-align: left;
      cursor: pointer;
    }
    .section-menu button:hover,
    .section-menu button:focus-visible {
      background: var(--vscode-list-hoverBackground);
      outline: none;
    }
    .section-menu button.active {
      background: color-mix(in srgb, var(--vscode-foreground) 10%, transparent);
      font-weight: 600;
    }
    .section-item-label {
      flex: 1 1 auto;
      min-width: 0;
      text-align: left;
    }
    .toolbar .field-wrap {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
      white-space: nowrap;
    }
    .toolbar .field-wrap.input-suffix-wrap > span:first-child {
      color: var(--vscode-descriptionForeground);
    }
    .input-suffix-field {
      position: relative;
      display: inline-flex;
      align-items: center;
      border-radius: 4px;
      overflow: hidden;
    }
    .input-suffix-field input {
      width: 64px;
      height: 26px;
      box-sizing: border-box;
      border: 1px solid var(--vscode-input-border, transparent);
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border-radius: 4px;
      padding: 0 28px 0 6px;
      font: inherit;
      -moz-appearance: textfield;
      appearance: textfield;
      overflow: hidden;
      background-clip: padding-box;
    }
    .input-suffix-field input::-webkit-outer-spin-button,
    .input-suffix-field input::-webkit-inner-spin-button {
      -webkit-appearance: none;
      margin: 0;
    }
    .input-suffix {
      position: absolute;
      right: 8px;
      top: 50%;
      transform: translateY(-50%);
      font-size: 11px;
      color: var(--vscode-input-placeholderForeground, var(--vscode-descriptionForeground));
      opacity: 0.72;
      pointer-events: none;
      user-select: none;
    }
    #dashboardToolbarFields {
      display: inline-flex;
      align-items: center;
      gap: 10px;
    }
    .content { padding: 14px; overflow: auto; flex: 1 1 auto; }
    .content.log-mode { padding: 10px 14px; }
    .card {
      border: 1px solid var(--vscode-panel-border);
      border-radius: 8px;
      padding: 12px 14px;
      background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
    }
    .card h2 {
      margin: 0 0 10px;
      font-size: 13px;
      display: flex;
      align-items: center;
      gap: 6px;
      font-weight: 600;
    }
    .card h2 .codicon { font-size: 14px; }
    .dash-grid {
      display: grid;
      grid-template-columns: minmax(280px, 1fr) minmax(280px, 1.2fr);
      gap: 12px;
      margin-bottom: 12px;
    }
    @media (max-width: 900px) {
      .dash-grid { grid-template-columns: 1fr; }
      .dash-charts-2 { grid-template-columns: 1fr; }
    }
    .dash-charts-2 {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
      margin-bottom: 12px;
    }
    .dash-queries {
      margin-bottom: 12px;
    }
    .info-rows { display: grid; gap: 8px; font-size: 12px; }
    .info-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      min-height: 22px;
    }
    .info-row .k { color: var(--vscode-descriptionForeground); }
    .info-row .v {
      text-align: right;
      word-break: break-all;
      font-family: var(--vscode-editor-font-family, monospace);
    }
    .toggle {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 42px;
      height: 20px;
      border-radius: 999px;
      font-size: 11px;
      font-weight: 600;
      padding: 0 8px;
      font-family: var(--vscode-font-family);
    }
    .toggle.on {
      background: color-mix(in srgb, var(--vscode-charts-green, #89d185) 35%, transparent);
      color: var(--vscode-charts-green, #3fa66c);
    }
    .toggle.off {
      background: color-mix(in srgb, var(--vscode-descriptionForeground) 22%, transparent);
      color: var(--vscode-descriptionForeground);
    }
    .legend {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      margin-bottom: 8px;
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
    }
    .legend span { display: inline-flex; align-items: center; gap: 5px; }
    .swatch {
      width: 10px;
      height: 10px;
      border-radius: 2px;
      display: inline-block;
    }
    .chart-wrap {
      width: 100%;
      height: 190px;
      position: relative;
      overflow: hidden;
      contain: strict;
    }
    .chart-wrap.tall { height: 230px; }
    .chart-wrap svg {
      width: 100%;
      height: 100%;
      display: block;
      overflow: hidden;
    }
    .error {
      color: var(--vscode-errorForeground);
      margin-bottom: 10px;
      font-size: 12px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 12px;
    }
    th, td {
      border-bottom: 1px solid var(--vscode-panel-border);
      padding: 6px 8px;
      text-align: left;
      vertical-align: top;
    }
    th { color: var(--vscode-descriptionForeground); font-weight: 600; }
    td.query {
      max-width: 420px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      font-family: var(--vscode-editor-font-family, monospace);
    }
    .kill {
      border: 1px solid transparent;
      background: transparent;
      color: var(--vscode-errorForeground);
      cursor: pointer;
      border-radius: 4px;
      padding: 2px 6px;
      font: inherit;
    }
    .kill:hover { border-color: color-mix(in srgb, var(--vscode-errorForeground) 40%, transparent); }
    .muted { color: var(--vscode-descriptionForeground); font-size: 12px; }
    .log-feed {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 12px;
      line-height: 1.55;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .log-line { display: block; }
    .log-ts {
      color: var(--vscode-charts-blue, #4a90d9);
      font-weight: 600;
    }
    .log-executing { color: var(--vscode-foreground); }
    .log-result, .log-completed {
      color: var(--vscode-charts-green, #3fa66c);
    }
    .log-fail { color: var(--vscode-errorForeground); }
    .chart-wrap path.chart-line {
      transition: none;
    }
  </style>
</head>
<body>
  <div class="main">
    <div class="toolbar">
      <div class="section-select-wrap" id="sectionSelectWrap">
        <button type="button" class="section-trigger" id="sectionTrigger" aria-haspopup="listbox" aria-expanded="false" aria-label="${L('webview.manager.section', 'Seção')}">
          <span class="section-item-icon section-trigger-icon" id="sectionTriggerIcon" aria-hidden="true"><i class="codicon codicon-pulse"></i></span>
          <span class="section-trigger-label" id="sectionTriggerLabel">${L('webview.manager.dashboard', 'Painel')}</span>
          <span class="section-trigger-chevron" aria-hidden="true"></span>
        </button>
        <ul class="section-menu" id="sectionMenu" role="listbox" aria-label="${L('webview.manager.sections', 'Seções')}">
          <li role="none"><button type="button" role="option" data-section="dashboard" class="active"><span class="section-item-icon"><i class="codicon codicon-pulse" aria-hidden="true"></i></span><span class="section-item-label">${L('webview.manager.dashboard', 'Painel')}</span></button></li>
          <li role="none"><button type="button" role="option" data-section="log"><span class="section-item-icon"><i class="codicon codicon-output" aria-hidden="true"></i></span><span class="section-item-label">${L('webview.manager.log', 'Log')}</span></button></li>
          <li role="none"><button type="button" role="option" data-section="processes"><span class="section-item-icon"><i class="codicon codicon-list-flat" aria-hidden="true"></i></span><span class="section-item-label">${L('webview.manager.processes', 'Processos')}</span></button></li>
        </ul>
      </div>
      <span class="conn-label" id="connLabel" title="${escapeHtml(label)}"><span class="section-item-icon" aria-hidden="true"><i class="codicon codicon-plug"></i></span><span class="conn-label-text">${escapeHtml(label)}</span></span>
      <span class="spacer"></span>
      <div id="dashboardToolbarFields">
        <label class="field-wrap input-suffix-wrap" title="${L('webview.manager.intervalTitle', 'Intervalo dos gráficos em minutos. 0 = sem limite.')}">
          <span>${L('webview.manager.interval', 'Intervalo')}</span>
          <span class="input-suffix-field">
            <input id="timeWindowInput" type="number" min="0" max="1440" step="1" value="${safeWindowMinutes}" aria-label="${L('webview.manager.intervalAria', 'Intervalo em minutos')}" />
            <span class="input-suffix">min</span>
          </span>
        </label>
        <label class="field-wrap input-suffix-wrap" title="${L('webview.manager.refreshTitle', 'Intervalo de atualização automática (1–60 segundos)')}">
          <span>${L('webview.manager.refresh', 'Atualizar')}</span>
          <span class="input-suffix-field">
            <input id="pollIntervalInput" type="number" min="1" max="60" step="1" value="${safePollSeconds}" aria-label="${L('webview.manager.refreshAria', 'Atualizar a cada segundos')}" />
            <span class="input-suffix">s</span>
          </span>
        </label>
      </div>
    </div>
    <div class="content" id="content">
      <div class="error" id="error" style="display:none;"></div>
      <div id="logView" style="display:none;" class="log-feed"></div>
      <div id="dashboardView"></div>
      <div id="processesView" style="display:none;"></div>
    </div>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const errorEl = document.getElementById('error');
    const contentEl = document.getElementById('content');
    const logView = document.getElementById('logView');
    const dashboardView = document.getElementById('dashboardView');
    const processesView = document.getElementById('processesView');
    const sectionTrigger = document.getElementById('sectionTrigger');
    const sectionTriggerIcon = document.getElementById('sectionTriggerIcon');
    const sectionTriggerLabel = document.getElementById('sectionTriggerLabel');
    const sectionMenu = document.getElementById('sectionMenu');
    const dashboardToolbarFields = document.getElementById('dashboardToolbarFields');
    const pollIntervalInput = document.getElementById('pollIntervalInput');
    const timeWindowInput = document.getElementById('timeWindowInput');
    let section = 'dashboard';
    let stickLogToBottom = true;
    let chartAnimFrame = 0;
    let displaySeries = [];
    let targetSeries = [];
    let dashboardBuilt = false;
    let pollDebounceTimer = 0;
    let windowDebounceTimer = 0;

    const SECTION_LABELS = {
      dashboard: t('webview.manager.dashboard', 'Painel'),
      log: t('webview.manager.log', 'Log'),
      processes: t('webview.manager.processes', 'Processos'),
    };
    const SECTION_ICONS = {
      dashboard: 'codicon-pulse',
      log: 'codicon-output',
      processes: 'codicon-list-flat',
    };

    function setSectionTriggerIcon(nextSection) {
      if (!sectionTriggerIcon) {
        return;
      }
      const icon = sectionTriggerIcon.querySelector('.codicon');
      if (!icon) {
        return;
      }
      icon.className = 'codicon ' + (SECTION_ICONS[nextSection] || SECTION_ICONS.dashboard);
    }

    function closeSectionMenu() {
      if (!sectionMenu || !sectionTrigger) {
        return;
      }
      sectionMenu.classList.remove('open');
      sectionTrigger.setAttribute('aria-expanded', 'false');
    }

    function toggleSectionMenu() {
      if (!sectionMenu || !sectionTrigger) {
        return;
      }
      const open = !sectionMenu.classList.contains('open');
      sectionMenu.classList.toggle('open', open);
      sectionTrigger.setAttribute('aria-expanded', open ? 'true' : 'false');
    }

    function clampPollSeconds(value) {
      const numeric = Number(value);
      if (!Number.isFinite(numeric)) {
        return 2;
      }
      return Math.max(1, Math.min(60, Math.trunc(numeric)));
    }

    function clampTimeWindowMinutes(value) {
      const numeric = Number(value);
      if (!Number.isFinite(numeric)) {
        return 2;
      }
      return Math.max(0, Math.min(1440, Math.trunc(numeric)));
    }

    function commitPollInterval() {
      if (!pollIntervalInput) {
        return;
      }
      const seconds = clampPollSeconds(pollIntervalInput.value);
      pollIntervalInput.value = String(seconds);
      vscode.postMessage({ type: 'setPollInterval', seconds });
    }

    function schedulePollCommit() {
      if (pollDebounceTimer) {
        clearTimeout(pollDebounceTimer);
      }
      pollDebounceTimer = setTimeout(() => {
        pollDebounceTimer = 0;
        commitPollInterval();
      }, 1000);
    }

    function commitTimeWindow() {
      if (!timeWindowInput) {
        return;
      }
      const minutes = clampTimeWindowMinutes(timeWindowInput.value);
      timeWindowInput.value = String(minutes);
      vscode.postMessage({ type: 'setTimeWindow', minutes });
    }

    function scheduleWindowCommit() {
      if (windowDebounceTimer) {
        clearTimeout(windowDebounceTimer);
      }
      windowDebounceTimer = setTimeout(() => {
        windowDebounceTimer = 0;
        commitTimeWindow();
      }, 1000);
    }

    pollIntervalInput?.addEventListener('input', schedulePollCommit);
    pollIntervalInput?.addEventListener('change', schedulePollCommit);
    pollIntervalInput?.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        if (pollDebounceTimer) {
          clearTimeout(pollDebounceTimer);
          pollDebounceTimer = 0;
        }
        commitPollInterval();
      }
    });

    timeWindowInput?.addEventListener('input', scheduleWindowCommit);
    timeWindowInput?.addEventListener('change', scheduleWindowCommit);
    timeWindowInput?.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        if (windowDebounceTimer) {
          clearTimeout(windowDebounceTimer);
          windowDebounceTimer = 0;
        }
        commitTimeWindow();
      }
    });

    const COLORS = {
      read: '#3fa66c',
      hit: '#4a90d9',
      insert: '#3fa66c',
      update: '#4a90d9',
      delete: '#b07d4f',
      select: '#9b6bdb',
      fetched: '#d16969',
    };
    const CHART_V_COLS = 8;

    function chartWindowMs(seriesLength) {
      const pollSec = clampPollSeconds(pollIntervalInput?.value || 2);
      const windowMin = clampTimeWindowMinutes(timeWindowInput?.value || 2);
      if (windowMin <= 0) {
        const count = Math.max(1, seriesLength || 60);
        return count * pollSec * 1000;
      }
      return windowMin * 60 * 1000;
    }

    function formatOffsetLabel(offsetMs) {
      if (offsetMs <= 500) {
        return '0';
      }
      let totalSec = Math.round(offsetMs / 1000);
      if (totalSec < 60) {
        return totalSec + 's';
      }
      const hours = Math.floor(totalSec / 3600);
      totalSec %= 3600;
      const min = Math.floor(totalSec / 60);
      const sec = totalSec % 60;
      if (hours > 0) {
        if (min === 0 && sec === 0) {
          return hours + 'h';
        }
        if (sec === 0) {
          return hours + 'h' + min;
        }
        if (min === 0) {
          return hours + 'h' + sec;
        }
        return hours + 'h' + min + 'm' + sec;
      }
      if (sec === 0) {
        return min + 'm';
      }
      return min + 'm' + sec;
    }

    const CHART_DEFS = [
      {
        id: 'trafficChart',
        keys: ['readKb', 'hitKb'],
        asKb: true,
        lines: [
          { key: 'readKb', color: COLORS.read },
          { key: 'hitKb', color: COLORS.hit },
        ],
      },
      {
        id: 'queriesChart',
        keys: ['insert', 'update', 'delete', 'select', 'fetched'],
        asKb: false,
        lines: [
          { key: 'insert', color: COLORS.insert },
          { key: 'update', color: COLORS.update },
          { key: 'delete', color: COLORS.delete },
          { key: 'select', color: COLORS.select },
          { key: 'fetched', color: COLORS.fetched },
        ],
      },
      {
        id: 'sessionsChart',
        keys: ['sessionsTotal', 'sessionsActive', 'sessionsIdle'],
        asKb: false,
        lines: [
          { key: 'sessionsTotal', color: COLORS.hit },
          { key: 'sessionsActive', color: COLORS.update },
          { key: 'sessionsIdle', color: COLORS.read },
        ],
      },
      {
        id: 'transactionsChart',
        keys: ['xactCommit', 'xactRollback'],
        asKb: false,
        lines: [
          { key: 'xactCommit', color: COLORS.update },
          { key: 'xactRollback', color: COLORS.read },
        ],
      },
      {
        id: 'tuplesInChart',
        keys: ['insert', 'update', 'delete'],
        asKb: false,
        lines: [
          { key: 'insert', color: COLORS.insert },
          { key: 'update', color: COLORS.update },
          { key: 'delete', color: COLORS.delete },
        ],
      },
      {
        id: 'tuplesOutChart',
        keys: ['fetched', 'select'],
        asKb: false,
        lines: [
          { key: 'fetched', color: COLORS.hit },
          { key: 'select', color: COLORS.update },
        ],
      },
    ];

    function allChartKeys() {
      const keys = [];
      CHART_DEFS.forEach((def) => {
        def.keys.forEach((key) => {
          if (keys.indexOf(key) === -1) {
            keys.push(key);
          }
        });
      });
      return keys;
    }

    logView.addEventListener('scroll', () => {
      const remaining = logView.scrollHeight - logView.scrollTop - logView.clientHeight;
      stickLogToBottom = remaining < 24;
    });

    function showError(message) {
      errorEl.style.display = '';
      errorEl.textContent = message || 'Erro';
    }

    function clearError() {
      errorEl.style.display = 'none';
      errorEl.textContent = '';
    }

    function setSection(next) {
      section = next === 'log' || next === 'processes' ? next : 'dashboard';
      if (sectionTriggerLabel) {
        sectionTriggerLabel.textContent = SECTION_LABELS[section] || t('webview.manager.dashboard', 'Painel');
      }
      setSectionTriggerIcon(section);
      sectionMenu?.querySelectorAll('button[data-section]').forEach((btn) => {
        btn.classList.toggle('active', btn.getAttribute('data-section') === section);
      });
      if (dashboardToolbarFields) {
        dashboardToolbarFields.style.display = section === 'dashboard' ? '' : 'none';
      }
      contentEl.classList.toggle('log-mode', section === 'log');
      logView.style.display = section === 'log' ? '' : 'none';
      dashboardView.style.display = section === 'dashboard' ? '' : 'none';
      processesView.style.display = section === 'processes' ? '' : 'none';
      closeSectionMenu();
    }

    function formatLogTime(iso) {
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) {
        return String(iso || '');
      }
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      const hh = String(d.getHours()).padStart(2, '0');
      const mm = String(d.getMinutes()).padStart(2, '0');
      const ss = String(d.getSeconds()).padStart(2, '0');
      return y + '-' + m + '-' + day + ' ' + hh + ':' + mm + ':' + ss;
    }

    function logClass(kind) {
      if (kind === 'result') return 'log-result';
      if (kind === 'completed') return 'log-completed';
      if (kind === 'fail') return 'log-fail';
      return 'log-executing';
    }

    function renderLogEntry(entry) {
      const line = document.createElement('div');
      line.className = 'log-line';
      line.innerHTML =
        '<span class="log-ts">' + escapeHtml(formatLogTime(entry.at)) + ' </span>' +
        '<span class="' + logClass(entry.kind) + '">' + escapeHtml(entry.message) + '</span>';
      return line;
    }

    function renderLogSnapshot(entries) {
      logView.innerHTML = '';
      const list = Array.isArray(entries) ? entries : [];
      if (list.length === 0) {
        logView.innerHTML = '<div class="muted">' + escapeHtml(t('webview.manager.noActivity', 'Nenhuma atividade registrada ainda.')) + '</div>';
        return;
      }
      list.forEach((entry) => {
        logView.appendChild(renderLogEntry(entry));
      });
      if (stickLogToBottom) {
        logView.scrollTop = logView.scrollHeight;
      }
    }

    function appendLogEntry(entry) {
      if (!entry) return;
      const empty = logView.querySelector('.muted');
      if (empty) {
        logView.innerHTML = '';
      }
      logView.appendChild(renderLogEntry(entry));
      if (stickLogToBottom) {
        logView.scrollTop = logView.scrollHeight;
      }
    }

    function toggleHtml(value) {
      if (value === true) {
        return '<span class="toggle on">' + escapeHtml(t('webview.manager.on', 'LIGADO')) + '</span>';
      }
      if (value === false) {
        return '<span class="toggle off">' + escapeHtml(t('webview.manager.off', 'DESLIGADO')) + '</span>';
      }
      return '<span class="v">—</span>';
    }

    function infoRow(label, valueHtml, id) {
      return '<div class="info-row"><span class="k">' + escapeHtml(label) + '</span><span id="' + id + '">' + valueHtml + '</span></div>';
    }

    function valueText(value) {
      const text = value == null || value === '' ? '—' : String(value);
      return '<span class="v">' + escapeHtml(text) + '</span>';
    }

    function legendItem(color, label) {
      return '<span><i class="swatch" style="background:' + color + '"></i>' + escapeHtml(label) + '</span>';
    }

    function chartCard(title, icon, legendHtml, chartId) {
      return '<div class="card chart-card">' +
        '<h2><i class="codicon codicon-' + icon + '" aria-hidden="true"></i>' + escapeHtml(title) + '</h2>' +
        legendHtml +
        '<div class="chart-wrap" id="' + chartId + '"></div>' +
      '</div>';
    }

    function ensureDashboardShell() {
      if (dashboardBuilt && dashboardView.querySelector('#trafficChart') && dashboardView.querySelector('#sessionsChart')) {
        return;
      }
      dashboardView.innerHTML =
        '<div class="dash-grid">' +
          '<div class="card">' +
            '<h2><i class="codicon codicon-server" aria-hidden="true"></i>' + escapeHtml(t('webview.manager.serverInfo', 'Informações do servidor')) + '</h2>' +
            '<div class="info-rows">' +
              infoRow(t('webview.manager.port', 'Porta'), valueText('—'), 'infoPort') +
              infoRow(t('webview.manager.version', 'Versão'), valueText('—'), 'infoVersion') +
              infoRow(t('webview.manager.slowQueryLog', 'Log de consultas lentas'), toggleHtml(null), 'infoSlow') +
              infoRow(t('webview.manager.activityTracking', 'Rastreamento de atividade'), toggleHtml(null), 'infoTrack') +
              infoRow(t('webview.manager.configFile', 'Arquivo de configuração'), valueText('—'), 'infoConfig') +
              infoRow(t('webview.manager.dataDir', 'Diretório de dados'), valueText('—'), 'infoDataDir') +
            '</div>' +
          '</div>' +
          '<div class="card">' +
            '<h2><i class="codicon codicon-zap" aria-hidden="true"></i>' + escapeHtml(t('webview.manager.traffic', 'Tráfego')) + '</h2>' +
            '<div class="legend">' +
              legendItem(COLORS.read, t('webview.manager.read', 'leitura')) +
              legendItem(COLORS.hit, t('webview.manager.hit', 'acerto')) +
            '</div>' +
            '<div class="chart-wrap" id="trafficChart"></div>' +
          '</div>' +
        '</div>' +
        '<div class="card dash-queries">' +
          '<h2><i class="codicon codicon-graph" aria-hidden="true"></i>' + escapeHtml(t('webview.manager.queries', 'Consultas')) + '</h2>' +
          '<div class="legend">' +
            legendItem(COLORS.insert, 'insert') +
            legendItem(COLORS.update, 'update') +
            legendItem(COLORS.delete, 'delete') +
            legendItem(COLORS.select, 'select') +
            legendItem(COLORS.fetched, 'fetched') +
          '</div>' +
          '<div class="chart-wrap tall" id="queriesChart"></div>' +
        '</div>' +
        '<div class="dash-charts-2">' +
          chartCard(
            t('webview.manager.sessions', 'Sessões do servidor'),
            'person',
            '<div class="legend">' +
              legendItem(COLORS.hit, t('webview.manager.total', 'total')) +
              legendItem(COLORS.update, t('webview.manager.active', 'ativas')) +
              legendItem(COLORS.read, t('webview.manager.idle', 'ociosas')) +
            '</div>',
            'sessionsChart',
          ) +
          chartCard(
            t('webview.manager.transactions', 'Transações por intervalo'),
            'sync',
            '<div class="legend">' +
              legendItem(COLORS.update, t('webview.manager.commits', 'commits')) +
              legendItem(COLORS.read, t('webview.manager.rollbacks', 'rollbacks')) +
            '</div>',
            'transactionsChart',
          ) +
        '</div>' +
        '<div class="dash-charts-2">' +
          chartCard(
            t('webview.manager.tuplesIn', 'Tuplas (entrada)'),
            'arrow-down',
            '<div class="legend">' +
              legendItem(COLORS.insert, 'inserts') +
              legendItem(COLORS.update, 'updates') +
              legendItem(COLORS.delete, 'deletes') +
            '</div>',
            'tuplesInChart',
          ) +
          chartCard(
            t('webview.manager.tuplesOut', 'Tuplas (saída)'),
            'arrow-up',
            '<div class="legend">' +
              legendItem(COLORS.hit, 'fetched') +
              legendItem(COLORS.update, 'returned') +
            '</div>',
            'tuplesOutChart',
          ) +
        '</div>';
      dashboardBuilt = true;
    }

    function setInfoSlot(id, html) {
      const el = document.getElementById(id);
      if (el) {
        el.innerHTML = html;
      }
    }

    function cloneSeries(series) {
      return (Array.isArray(series) ? series : []).map((p) => ({
        t: p.t,
        label: p.label || '',
        readKb: p.readKb == null ? null : Number(p.readKb),
        hitKb: p.hitKb == null ? null : Number(p.hitKb),
        insert: p.insert == null ? null : Number(p.insert),
        update: p.update == null ? null : Number(p.update),
        delete: p.delete == null ? null : Number(p.delete),
        select: p.select == null ? null : Number(p.select),
        fetched: p.fetched == null ? null : Number(p.fetched),
        xactCommit: p.xactCommit == null ? null : Number(p.xactCommit),
        xactRollback: p.xactRollback == null ? null : Number(p.xactRollback),
        sessionsTotal: p.sessionsTotal == null ? null : Number(p.sessionsTotal),
        sessionsActive: p.sessionsActive == null ? null : Number(p.sessionsActive),
        sessionsIdle: p.sessionsIdle == null ? null : Number(p.sessionsIdle),
      }));
    }

    function seriesMax(series, keys) {
      let maxY = 0;
      (series || []).forEach((p) => {
        keys.forEach((key) => {
          if (p[key] == null) {
            return;
          }
          maxY = Math.max(maxY, Number(p[key] || 0));
        });
      });
      return maxY > 0 ? maxY : 1;
    }

    function isGapValue(value) {
      return value == null || !Number.isFinite(Number(value));
    }

    function chartLayout(host) {
      const width = Math.max(320, host.clientWidth || 480);
      const height = host.clientHeight || 180;
      const diagonal = width < 560 || width - 44 - 40 < 220;
      const padL = 44;
      const padR = diagonal ? 22 : 40;
      const padT = 12;
      // Diagonal labels need room below the plot; keep stroke inset inside the clip.
      const padB = diagonal ? 52 : 28;
      const strokeInset = 2;
      return {
        width,
        height,
        padL,
        padR,
        padT,
        padB,
        innerW: width - padL - padR,
        innerH: height - padT - padB,
        strokeInset,
        diagonal,
      };
    }

    function xForIndex(layout, index, count) {
      // Visible slots 0..count-1 span the full plot; buffers sit at -1 and count (outside clip).
      const xCount = Math.max(1, count - 1);
      return layout.padL + (index / xCount) * layout.innerW;
    }

    function slotWidth(layout, count) {
      const xCount = Math.max(1, count - 1);
      return layout.innerW / xCount;
    }

    function yForGrid(layout, value, maxY) {
      const inset = layout.strokeInset || 2;
      const top = layout.padT + inset;
      const usable = Math.max(1, layout.innerH - inset * 2);
      return top + usable - (Number(value || 0) / maxY) * usable;
    }

    function yForValue(layout, value, maxY) {
      // Keep the 2px stroke inside the top/bottom grid (half-stroke pad).
      const inset = layout.strokeInset || 2;
      const strokePad = 1;
      const top = layout.padT + inset + strokePad;
      const usable = Math.max(1, layout.innerH - inset * 2 - strokePad * 2);
      return top + usable - (Number(value || 0) / maxY) * usable;
    }

    function pointTrackValues(p, keys, layout, maxY) {
      const values = {};
      keys.forEach((key) => {
        const gap = isGapValue(p[key]);
        values[key] = {
          y: gap ? null : yForValue(layout, p[key], maxY),
          gap,
        };
      });
      return values;
    }

    function makeTrack(p, role, x0, x1, keys, layout, maxY) {
      return {
        t: p.t,
        role: role,
        x0: x0,
        x1: x1,
        values: pointTrackValues(p, keys, layout, maxY),
      };
    }

    /**
     * Buffers always carry rendered line content (never empty edges):
     * - left buffer: copy of the first visible slice (same Y), so the edge is not cropped
     * - right buffer: new slice while sliding (or copy of last when settled); removed only after anim
     */
    function buildScrollTracks(fromSeries, toSeries, layout, keys, maxY) {
      const count = Math.max(1, (toSeries || []).length);
      const shift = slotWidth(layout, count);
      const tracks = [];
      const firstVisible = fromSeries[0];

      // Left buffer starts already off-screen as a copy of the first visible slice.
      tracks.push(
        makeTrack(
          firstVisible,
          'leftBuffer',
          xForIndex(layout, -1, count),
          xForIndex(layout, -1, count) - shift,
          keys,
          layout,
          maxY,
        ),
      );

      // Oldest visible sample exits into the left buffer; dropped only after the slide ends.
      tracks.push(
        makeTrack(
          firstVisible,
          'leaving',
          xForIndex(layout, 0, count),
          xForIndex(layout, -1, count),
          keys,
          layout,
          maxY,
        ),
      );

      (toSeries || []).forEach((p, i) => {
        const endX = xForIndex(layout, i, count);
        const isNew = i === count - 1;
        tracks.push(
          makeTrack(
            p,
            isNew ? 'rightBuffer' : 'visible',
            endX + shift,
            endX,
            keys,
            layout,
            maxY,
          ),
        );
      });

      return tracks;
    }

    function interpolateScrollTracks(tracks, keys, progress) {
      return (tracks || []).map((track) => {
        const x = track.x0 + (track.x1 - track.x0) * progress;
        const point = {
          t: track.t,
          role: track.role,
          x,
        };
        keys.forEach((key) => {
          const v = track.values[key];
          point[key] = v.gap || v.y == null
            ? { x, y: null, gap: true }
            : { x, y: v.y, gap: false };
        });
        return point;
      });
    }

    function settledTracks(series, layout, keys, maxY) {
      const count = Math.max(1, (series || []).length);
      const tracks = [];
      if (!series || series.length === 0) {
        return tracks;
      }
      const first = series[0];
      const last = series[count - 1];
      // Edge ghosts: copies of first/last so stroke is never cropped at the clip.
      tracks.push(
        makeTrack(
          first,
          'leftBuffer',
          xForIndex(layout, -1, count),
          xForIndex(layout, -1, count),
          keys,
          layout,
          maxY,
        ),
      );
      series.forEach((p, i) => {
        const x = xForIndex(layout, i, count);
        tracks.push(makeTrack(p, 'visible', x, x, keys, layout, maxY));
      });
      tracks.push(
        makeTrack(
          last,
          'rightBuffer',
          xForIndex(layout, count, count),
          xForIndex(layout, count, count),
          keys,
          layout,
          maxY,
        ),
      );
      return tracks;
    }

    let chartMotion = {};

    function makeMotion(from, to, layout, keys, maxY, asKb, sliding) {
      return {
        tracks: sliding
          ? buildScrollTracks(from, to, layout, keys, maxY)
          : settledTracks(to, layout, keys, maxY),
        keys,
        maxY,
        layout,
        asKb,
      };
    }

    function buildChartMotions(from, to, sliding) {
      const motions = {};
      CHART_DEFS.forEach((def) => {
        const host = document.getElementById(def.id);
        if (!host) {
          return;
        }
        const layout = chartLayout(host);
        const maxY = Math.max(seriesMax(from, def.keys), seriesMax(to, def.keys));
        motions[def.id] = makeMotion(from, to, layout, def.keys, maxY, def.asKb, sliding);
      });
      return motions;
    }

    function animateChartsTo(nextSeries) {
      const from = cloneSeries(displaySeries);
      const to = cloneSeries(nextSeries);
      targetSeries = to;
      if (chartAnimFrame) {
        cancelAnimationFrame(chartAnimFrame);
        chartAnimFrame = 0;
      }

      const hostsReady = CHART_DEFS.every((def) => document.getElementById(def.id));
      if (!hostsReady) {
        displaySeries = to;
        return;
      }

      const metricKeys = allChartKeys();
      const onlyNull = !to.some((p) => metricKeys.some((k) => !isGapValue(p[k])));
      const unchanged =
        from.length === to.length &&
        from.length > 0 &&
        from[from.length - 1].t === to[to.length - 1].t;
      const canSlide =
        !onlyNull && !unchanged && from.length === to.length && to.length > 0;

      if (!canSlide) {
        displaySeries = to;
        chartMotion = buildChartMotions(from, to, false);
        paintMotion(1);
        return;
      }

      chartMotion = buildChartMotions(from, to, true);
      paintMotion(0);

      chartAnimFrame = requestAnimationFrame(() => {
        const started = performance.now();
        const duration = 220;

        function frame(now) {
          const progress = Math.min(1, (now - started) / duration);
          paintMotion(progress);
          if (progress < 1) {
            chartAnimFrame = requestAnimationFrame(frame);
            return;
          }
          displaySeries = cloneSeries(targetSeries);
          chartMotion = buildChartMotions(to, to, false);
          paintMotion(1);
          chartAnimFrame = 0;
        }

        chartAnimFrame = requestAnimationFrame(frame);
      });
    }

    function paintMotion(progress) {
      CHART_DEFS.forEach((def) => {
        const motion = chartMotion[def.id];
        if (!motion) {
          return;
        }
        drawTrackedChart(
          document.getElementById(def.id),
          motion,
          def.lines,
          progress,
        );
      });
    }

    function renderDashboard(dashboard) {
      if (!dashboard || !dashboard.server) {
        dashboardView.innerHTML = '<div class="muted">' + escapeHtml(t('webview.manager.loading', 'Carregando…')) + '</div>';
        dashboardBuilt = false;
        return;
      }
      ensureDashboardShell();
      const server = dashboard.server;
      setInfoSlot('infoPort', valueText(server.port));
      setInfoSlot('infoVersion', valueText(server.version));
      setInfoSlot('infoSlow', toggleHtml(server.slowQueryLog));
      setInfoSlot('infoTrack', toggleHtml(server.activityTracking));
      setInfoSlot('infoConfig', valueText(server.configFile));
      setInfoSlot('infoDataDir', valueText(server.dataDirectory));
      animateChartsTo(Array.isArray(dashboard.series) ? dashboard.series : []);
    }

    function formatAxisY(v, asKb) {
      if (asKb) {
        if (v >= 1024) return (v / 1024).toFixed(v >= 10240 ? 0 : 1) + 'MB';
        return (Math.round(v * 10) / 10) + 'KB';
      }
      return String(Math.round(v * 100) / 100);
    }

    function drawTrackedChart(host, motion, lines, progress) {
      if (!host || !motion) return;
      const layout = motion.layout;
      const maxY = motion.maxY;
      const vertices = interpolateScrollTracks(motion.tracks, motion.keys, progress);
      const yTicks = [0, maxY / 2, maxY];
      const gridStroke = 'color-mix(in srgb, var(--vscode-foreground) 26%, transparent)';

      function snapPx(value) {
        // Center 1px strokes on device pixels to avoid ~2px blur.
        return Math.round(value) + 0.5;
      }

      let svgEl = host.querySelector('svg.chart-svg');
      if (!svgEl) {
        host.innerHTML =
          '<svg class="chart-svg" viewBox="0 0 ' +
          layout.width +
          ' ' +
          layout.height +
          '" preserveAspectRatio="none"></svg>';
        svgEl = host.querySelector('svg.chart-svg');
      }
      svgEl.setAttribute('viewBox', '0 0 ' + layout.width + ' ' + layout.height);
      svgEl.setAttribute('width', String(layout.width));
      svgEl.setAttribute('height', String(layout.height));
      svgEl.setAttribute('overflow', 'hidden');
      svgEl.setAttribute('shape-rendering', 'geometricPrecision');

      let defs = svgEl.querySelector('defs');
      if (!defs) {
        defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
        svgEl.insertBefore(defs, svgEl.firstChild);
      }
      const clipId = 'chartPlotClip-' + (host.id || 'chart');
      let clip = defs.querySelector('#' + clipId);
      if (!clip) {
        clip = document.createElementNS('http://www.w3.org/2000/svg', 'clipPath');
        clip.setAttribute('id', clipId);
        const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        clip.appendChild(rect);
        defs.appendChild(clip);
      }
      const clipRect = clip.querySelector('rect');
      // Clip is the visible plot only; buffers render outside and feed stroke into the edges.
      clipRect.setAttribute('x', String(layout.padL));
      clipRect.setAttribute('y', String(layout.padT));
      clipRect.setAttribute('width', String(layout.innerW));
      clipRect.setAttribute('height', String(layout.innerH));
      const clipUrl = 'url(#' + clipId + ')';

      let gridLayer = svgEl.querySelector('g.chart-grid');
      if (!gridLayer) {
        gridLayer = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        gridLayer.setAttribute('class', 'chart-grid');
        svgEl.appendChild(gridLayer);
      }
      gridLayer.innerHTML = '';
      gridLayer.setAttribute('shape-rendering', 'crispEdges');

      const gridTop = snapPx(yForGrid(layout, maxY, maxY));
      const gridBottom = snapPx(yForGrid(layout, 0, maxY));
      const vCols = CHART_V_COLS;

      // Vertical grid — same Y span as the horizontal axis lines.
      for (let i = 0; i <= vCols; i += 1) {
        const x = snapPx(layout.padL + (i / vCols) * layout.innerW);
        const vline = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        vline.setAttribute('x1', String(x));
        vline.setAttribute('x2', String(x));
        vline.setAttribute('y1', String(gridTop));
        vline.setAttribute('y2', String(gridBottom));
        vline.setAttribute('stroke', gridStroke);
        vline.setAttribute('stroke-width', '1');
        gridLayer.appendChild(vline);
      }

      // Horizontal grid + Y labels.
      yTicks.forEach((tick) => {
        const y = snapPx(yForGrid(layout, tick, maxY));
        const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        line.setAttribute('x1', String(snapPx(layout.padL)));
        line.setAttribute('y1', String(y));
        line.setAttribute('x2', String(snapPx(layout.padL + layout.innerW)));
        line.setAttribute('y2', String(y));
        line.setAttribute('stroke', gridStroke);
        line.setAttribute('stroke-width', '1');
        gridLayer.appendChild(line);
        const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        text.setAttribute('x', String(layout.padL - 6));
        text.setAttribute('y', String(y + 3));
        text.setAttribute('text-anchor', 'end');
        text.setAttribute('font-size', '10');
        text.setAttribute('fill', 'var(--vscode-descriptionForeground)');
        text.setAttribute('shape-rendering', 'geometricPrecision');
        text.textContent = formatAxisY(tick, motion.asKb);
        gridLayer.appendChild(text);
      });

      const windowMs = chartWindowMs(targetSeries.length || displaySeries.length);

      let labelsLayer = svgEl.querySelector('g.chart-labels');
      if (!labelsLayer) {
        labelsLayer = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        labelsLayer.setAttribute('class', 'chart-labels');
        svgEl.appendChild(labelsLayer);
      }
      // One offset label per vertical grid line (fixed; not animated with the series).
      labelsLayer.removeAttribute('clip-path');
      labelsLayer.innerHTML = '';
      const plotBottom = layout.padT + layout.innerH;
      for (let i = 0; i <= vCols; i += 1) {
        const x = layout.padL + (i / vCols) * layout.innerW;
        const offsetMs = windowMs * (vCols - i) / vCols;
        const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        text.setAttribute('font-size', '10');
        text.setAttribute('fill', 'var(--vscode-descriptionForeground)');
        text.textContent = formatOffsetLabel(offsetMs);
        if (layout.diagonal) {
          const y = plotBottom + 14;
          text.setAttribute('x', String(x));
          text.setAttribute('y', String(y));
          text.setAttribute('text-anchor', 'end');
          text.setAttribute('dominant-baseline', 'middle');
          text.setAttribute('transform', 'rotate(-40 ' + x + ' ' + y + ')');
        } else {
          const y = plotBottom + 16;
          text.setAttribute('x', String(x));
          text.setAttribute('y', String(y));
          text.setAttribute('dominant-baseline', 'hanging');
          if (i === 0) {
            text.setAttribute('text-anchor', 'start');
          } else if (i === vCols) {
            text.setAttribute('text-anchor', 'end');
          } else {
            text.setAttribute('text-anchor', 'middle');
          }
        }
        labelsLayer.appendChild(text);
      }

      let linesLayer = svgEl.querySelector('g.chart-lines');
      if (!linesLayer) {
        linesLayer = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        linesLayer.setAttribute('class', 'chart-lines');
        svgEl.appendChild(linesLayer);
      }
      linesLayer.setAttribute('clip-path', clipUrl);
      lines.forEach((line) => {
        const pathId = 'chart-line-' + line.key;
        let path = linesLayer.querySelector('#' + pathId);
        if (!path) {
          path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
          path.setAttribute('id', pathId);
          path.setAttribute('class', 'chart-line');
          path.setAttribute('fill', 'none');
          path.setAttribute('stroke', line.color);
          path.setAttribute('stroke-width', '2');
          path.setAttribute('stroke-linecap', 'butt');
          path.setAttribute('stroke-linejoin', 'bevel');
          path.setAttribute('vector-effect', 'non-scaling-stroke');
          linesLayer.appendChild(path);
        }
        let d = '';
        let penUp = true;
        vertices.forEach((vertex) => {
          const pt = vertex[line.key];
          if (!pt || pt.gap || pt.y == null) {
            penUp = true;
            return;
          }
          d += (penUp ? 'M ' : 'L ') + pt.x + ' ' + pt.y + ' ';
          penUp = false;
        });
        path.setAttribute('d', d.trim());
        path.setAttribute('stroke', line.color);
        path.setAttribute('stroke-width', '2');
        path.setAttribute('stroke-linecap', 'butt');
        path.setAttribute('stroke-linejoin', 'bevel');
        path.setAttribute('vector-effect', 'non-scaling-stroke');
      });

      Array.from(linesLayer.querySelectorAll('path.chart-line')).forEach((path) => {
        const key = String(path.id || '').replace('chart-line-', '');
        if (!lines.some((line) => line.key === key)) {
          path.remove();
        }
      });
    }

    function renderProcesses(processes) {
      const list = Array.isArray(processes) ? processes : [];
      if (list.length === 0) {
        processesView.innerHTML = '<div class="muted">' + escapeHtml(t('webview.manager.noProcesses', 'Nenhum processo encontrado.')) + '</div>';
        return;
      }
      let html = '<table><thead><tr><th>' + escapeHtml(t('webview.manager.pid', 'PID')) + '</th><th>' + escapeHtml(t('webview.manager.user', 'Usuário')) + '</th><th>' + escapeHtml(t('webview.manager.database', 'Banco')) + '</th><th>' + escapeHtml(t('webview.manager.app', 'App')) + '</th><th>' + escapeHtml(t('webview.manager.state', 'Estado')) + '</th><th>' + escapeHtml(t('webview.manager.query', 'Query')) + '</th><th></th></tr></thead><tbody>';
      list.forEach((p) => {
        html += '<tr>' +
          '<td>' + escapeHtml(String(p.pid)) + '</td>' +
          '<td>' + escapeHtml(String(p.usename || '')) + '</td>' +
          '<td>' + escapeHtml(String(p.datname || '')) + '</td>' +
          '<td>' + escapeHtml(String(p.applicationName || '')) + '</td>' +
          '<td>' + escapeHtml(String(p.state || '')) + '</td>' +
          '<td class="query" title="' + escapeAttr(String(p.query || '')) + '">' + escapeHtml(String(p.query || '')) + '</td>' +
          '<td><button type="button" class="kill" data-pid="' + escapeAttr(String(p.pid)) + '">' + escapeHtml(t('webview.manager.terminate', 'Encerrar')) + '</button></td>' +
          '</tr>';
      });
      html += '</tbody></table>';
      processesView.innerHTML = html;
      processesView.querySelectorAll('button.kill').forEach((btn) => {
        btn.addEventListener('click', () => {
          const pid = Number(btn.getAttribute('data-pid'));
          vscode.postMessage({ type: 'terminate', pid });
        });
      });
    }

    function escapeHtml(value) {
      return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    function escapeAttr(value) {
      return escapeHtml(value).replace(/'/g, '&#39;');
    }

    sectionTrigger?.addEventListener('click', (event) => {
      event.stopPropagation();
      toggleSectionMenu();
    });
    sectionMenu?.querySelectorAll('button[data-section]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const next = btn.getAttribute('data-section');
        setSection(next);
        vscode.postMessage({ type: 'setSection', section: next });
      });
    });
    document.addEventListener('click', (event) => {
      const wrap = document.getElementById('sectionSelectWrap');
      if (!wrap || wrap.contains(event.target)) {
        return;
      }
      closeSectionMenu();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        closeSectionMenu();
      }
    });

    window.addEventListener('message', (event) => {
      const message = event.data || {};
      if (message.type === 'error') {
        showError(message.message);
        return;
      }
      clearError();
      if (message.type === 'section') {
        setSection(message.section);
      }
      if (message.type === 'logSnapshot') {
        renderLogSnapshot(message.entries);
      }
      if (message.type === 'logEntry') {
        appendLogEntry(message.entry);
      }
      if (message.type === 'pollInterval') {
        if (pollIntervalInput && !pollDebounceTimer) {
          pollIntervalInput.value = String(clampPollSeconds(message.seconds));
        }
      }
      if (message.type === 'timeWindow') {
        if (timeWindowInput && !windowDebounceTimer) {
          timeWindowInput.value = String(clampTimeWindowMinutes(message.minutes));
        }
      }
      if (message.type === 'dashboard') {
        renderDashboard(message.dashboard);
      }
      if (message.type === 'processes') {
        renderProcesses(message.processes);
      }
    });

    window.addEventListener('resize', () => {
      if (section === 'dashboard' && targetSeries.length) {
        displaySeries = cloneSeries(targetSeries);
        animateChartsTo(targetSeries);
      }
    });

    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
