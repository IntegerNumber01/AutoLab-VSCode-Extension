import * as vscode from "vscode";
import * as path from "path";

export function activate(context: vscode.ExtensionContext) {
  // Webview view in the sidebar
  const provider = new AutolabViewProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("autolab.explorer", provider, { webviewOptions: { retainContextWhenHidden: true } })
  );

  // Open Settings filtered to autolab
  context.subscriptions.push(
    vscode.commands.registerCommand("autolab.configure", async () => {
      await vscode.commands.executeCommand("workbench.action.openSettings", "autolab");
    })
  );

  // Pick a folder and save to settings
  context.subscriptions.push(
    vscode.commands.registerCommand("autolab.selectWorkspace", async () => {
      const pick = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: "Select workspace folder"
      });
      if (!pick || pick.length === 0) {return;}

      const folder = pick[0].fsPath;
      const cfg = vscode.workspace.getConfiguration();
      await cfg.update("autolab.workspaceFolder", folder, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage(`Autolab workspace set to: ${folder}`);
    })
  );
}

export function deactivate() {}

class AutolabViewProvider implements vscode.WebviewViewProvider {
  constructor(private readonly ctx: vscode.ExtensionContext) {}

  resolveWebviewView(webviewView: vscode.WebviewView) {
    const { webview } = webviewView;
    webview.options = { enableScripts: true, localResourceRoots: [this.ctx.extensionUri] };

    const nonce = getNonce();
    webview.html = this.getHtml(webview, nonce);

    // Listen for button clicks from the webview
    webview.onDidReceiveMessage(async (msg) => {
      if (msg?.type === "configure") {
        await vscode.commands.executeCommand("autolab.configure");
      } else if (msg?.type === "selectWorkspace") {
        await vscode.commands.executeCommand("autolab.selectWorkspace");
      }
    });
  }

  private getHtml(webview: vscode.Webview, nonce: string): string {
    // Use theme colors for a native feel
    const style = `
      :root {
        --btn-bg: var(--vscode-button-background);
        --btn-bg-hover: var(--vscode-button-hoverBackground);
        --btn-fg: var(--vscode-button-foreground);
        --panel-bg: var(--vscode-sideBar-background);
        --panel-fg: var(--vscode-foreground);
        --border: var(--vscode-editorGroup-border);
      }
      body {
        padding: 14px 12px;
        background: var(--panel-bg);
        color: var(--panel-fg);
        font: 13px var(--vscode-font-family);
      }
      .card {
        border: 1px solid var(--border);
        border-radius: 8px;
        padding: 16px;
      }
      .actions { display: grid; gap: 8px; }
      button.primary {
        all: unset;
        display: inline-block;
        text-align: center;
        padding: 10px 14px;
        border-radius: 6px;
        background: var(--btn-bg);
        color: var(--btn-fg);
        cursor: pointer;
        font-weight: 600;
      }
      button.primary:hover { background: var(--btn-bg-hover); }
      .sub {
        font-size: 12px;
        opacity: 0.8;
        margin-top: 8px;
      }
    `;

    const script = `
      const vscode = acquireVsCodeApi();
      document.getElementById('configure').addEventListener('click', () => {
        vscode.postMessage({ type: 'configure' });
      });
      document.getElementById('select').addEventListener('click', () => {
        vscode.postMessage({ type: 'selectWorkspace' });
      });
    `;

    return /* html */ `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>${style}</style>
        <title>Autolab</title>
      </head>
      <body>
        <div class="card">
          <div class="actions">
            <button id="configure" class="primary">Configure</button>
            <button id="select" class="primary">Select Workspace Folder…</button>
            <div class="sub">Configure opens Settings filtered to <code>autolab</code>. You can also pick a workspace folder here.</div>
          </div>
        </div>
        <script nonce="${nonce}">${script}</script>
      </body>
      </html>
    `;
  }
}

function getNonce() {
  let text = "";
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {text += possible.charAt(Math.floor(Math.random() * possible.length));}
  return text;
}
