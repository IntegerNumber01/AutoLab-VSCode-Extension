import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";

export function activate(context: vscode.ExtensionContext) {
  // Webview view in the sidebar
  const provider = new AutolabViewProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("autolab.explorer", provider, { webviewOptions: { retainContextWhenHidden: true } })
  );

  // Tree data providers for the list views
  const assignmentsProvider = new EmptyTreeDataProvider("You have not yet opened a folder.");
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("autolab.assignments", assignmentsProvider)
  );

  const submissionsProvider = new EmptyTreeDataProvider("No submissions yet.");
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("autolab.submissions", submissionsProvider)
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

class EmptyTreeDataProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  constructor(private message: string) {}

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(): vscode.TreeItem[] {
    const item = new vscode.TreeItem(this.message);
    item.contextValue = "empty";
    return [item];
  }
}

export function deactivate() {}

class AutolabViewProvider implements vscode.WebviewViewProvider {
  constructor(private readonly ctx: vscode.ExtensionContext) {}

  resolveWebviewView(webviewView: vscode.WebviewView) {
    const { webview } = webviewView;
    webview.options = { enableScripts: true, localResourceRoots: [this.ctx.extensionUri] };

    const nonce = getNonce();
    webview.html = this.getHtml(webview, nonce);

    webview.onDidReceiveMessage(async (msg) => {
      if (msg?.type === "configure") {
        await vscode.commands.executeCommand("autolab.configure");
      }
    });
  }

  private getHtml(webview: vscode.Webview, nonce: string): string {
    const toolkitUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.ctx.extensionUri, "node_modules", "@vscode/webview-ui-toolkit", "dist", "toolkit.js")
    );

    const htmlPath = path.join(this.ctx.extensionPath, "webview", "sidebar.html");
    let html = fs.readFileSync(htmlPath, "utf8");

    html = html.replace(/{{nonce}}/g, nonce);
    html = html.replace(/{{toolkitUri}}/g, toolkitUri.toString());
    html = html.replace(/{{cspSource}}/g, webview.cspSource);

    return html;
  }
}

function getNonce() {
  let text = "";
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {text += possible.charAt(Math.floor(Math.random() * possible.length));}
  return text;
}
