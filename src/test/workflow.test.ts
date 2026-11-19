import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/** Load the extension boundary with a small VS Code double; no Electron or real account needed. */
function loadWithMocks<T>(filename: string, mocks: Record<string, unknown>): T {
  const loader = require("module") as { _load: (name: string, ...args: unknown[]) => unknown };
  const original = loader._load;
  const resolved = require.resolve(filename);
  delete require.cache[resolved];
  loader._load = function (name, ...args) {
    return name in mocks ? mocks[name] : original.call(this, name, ...args);
  };
  try { return require(filename) as T; }
  finally { loader._load = original; delete require.cache[resolved]; }
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 4; i++) { await new Promise<void>((resolve) => setImmediate(resolve)); }
};
const disposable = { dispose: () => {} };

suite("Lab workspace and sidebar workflow", () => {
  test("detects metadata without an editor and routes explicitly selected or moved labs", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "autolab-workspace-"));
    try {
      const directories = [path.join(root, "one"), path.join(root, "two")];
      for (const [index, directory] of directories.entries()) {
        await fs.promises.mkdir(path.join(directory, ".autolab"), { recursive: true });
        await fs.promises.writeFile(path.join(directory, ".autolab", "assessment.json"), JSON.stringify({
          version: 1, host: "https://example.edu", course: "course", assessment: `lab${index}`, artifacts: [],
        }));
      }
      const workspace = {
        workspaceFolders: directories.map((directory) => ({ uri: { fsPath: directory } })),
        getWorkspaceFolder: (uri: { fsPath: string }) => workspace.workspaceFolders.find((folder) => uri.fsPath === folder.uri.fsPath),
      };
      const metadata = loadWithMocks<typeof import("../metadata")>("../metadata", {
        vscode: { workspace, window: {}, Uri: { file: (fsPath: string) => ({ fsPath }) } },
        "./config": { readSettings: () => ({ host: "https://example.edu", workspaceFolder: "" }) },
      });
      assert.strictEqual((await metadata.findCurrentLab())?.metadata.assessment, "lab0");
      metadata.selectCurrentLab(directories[1]);
      assert.strictEqual((await metadata.findCurrentLab())?.metadata.assessment, "lab1");
      // No download root is configured; an opened folder still provides the identity.
      assert.strictEqual((await metadata.localLabFor("course", "lab1"))?.directory, directories[1]);
      assert.strictEqual(await metadata.localLabFor("other-course", "lab1"), undefined);
      workspace.workspaceFolders.pop();
      assert.strictEqual((await metadata.findCurrentLab())?.metadata.assessment, "lab0");
    } finally { await fs.promises.rm(root, { recursive: true, force: true }); }
  });

  test("opens in the same workspace, saves before adding, and avoids duplicate folders", async () => {
    const calls: string[] = [];
    const folder = { uri: { toString: () => "file:///lab" } };
    const workspace = {
      workspaceFolders: [] as typeof folder[],
      updateWorkspaceFolders: (index: number, count: number, added: typeof folder) => {
        calls.push("add");
        assert.strictEqual(index, 0);
        assert.strictEqual(count, 0);
        workspace.workspaceFolders.push(added);
        return true;
      },
    };
    const { openLabWindow } = loadWithMocks<typeof import("../downloads")>("../downloads", {
      vscode: { workspace, Uri: { file: () => folder.uri }, commands: { executeCommand: async (command: string) => { calls.push(command); } } },
      "./config": {}, "./metadata": {},
    });
    await openLabWindow("/lab");
    await openLabWindow("/lab");
    assert.deepStrictEqual(calls, ["autolab.prepareLab", "add", "autolab.focusLab", "autolab.prepareLab", "autolab.focusLab"]);
    assert.ok(!calls.includes("vscode.openFolder"));
  });

  test("reports a rejected workspace addition without pretending to focus it", async () => {
    const calls: string[] = [];
    const { openLabWindow } = loadWithMocks<typeof import("../downloads")>("../downloads", {
      vscode: {
        workspace: { workspaceFolders: [], updateWorkspaceFolders: () => false },
        Uri: { file: () => ({ toString: () => "file:///lab" }) },
        commands: { executeCommand: async (command: string) => { calls.push(command); } },
      }, "./config": {}, "./metadata": {},
    });
    await assert.rejects(openLabWindow("/lab"), /could not add/);
    assert.deepStrictEqual(calls, ["autolab.prepareLab"]);
  });

  function sidebarHarness(find?: (course: string, assessment: string) => Promise<unknown>) {
    let receive: (message: unknown) => void = () => {};
    let refresh: () => void = () => {};
    let resolveView = (): void => {};
    let focusCount = 0;
    const view = {
      webview: { html: "", options: {}, onDidReceiveMessage: (listener: typeof receive) => { receive = listener; return disposable; } },
      onDidDispose: () => disposable,
    };
    const details = { name: "lab", display_name: "Test Lab", start_at: null, due_at: null, end_at: null };
    const api = {
      getAssessment: async () => details, getProblems: async () => [],
      getSubmissions: async () => [2, 1].map((version) => ({ version, filename: "submission.zip", created_at: "2026-01-01", scores: { correctness: version } })),
      getFeedback: async (_course: string, _assessment: string, version: number) => `Output for version ${version}`,
    };
    const { LabSidebar } = loadWithMocks<typeof import("../sidebar")>("../sidebar", {
      vscode: {
        languages: { createDiagnosticCollection: () => ({ ...disposable, clear: () => {}, set: () => {} }) },
        commands: {
          executeCommand: async (command: string) => {
            assert.strictEqual(command, "autolab.details.focus");
            focusCount++;
            resolveView();
          },
        },
        EventEmitter: class { event = () => disposable; fire(): void {} dispose(): void {} },
      },
      "./config": { readSettings: () => ({ host: "https://example.edu" }) },
      "./metadata": { findCurrentLab: async () => undefined, localLabFor: async () => undefined },
    });
    const session = { hasSession: async () => true, api: () => api };
    const model = { find: find ?? (async () => undefined), onDidChange: (listener: () => void) => { refresh = listener; return disposable; } };
    const sidebar = new LabSidebar(session as never, model as never);
    let resolved = false;
    resolveView = () => { if (!resolved) { resolved = true; sidebar.resolveWebviewView(view as never); } };
    return { sidebar, view, receive: (message: unknown) => receive(message), refresh: () => refresh(), focusCount: () => focusCount };
  }

  test("shows run versions in the sidebar and retains the selected version on refresh", async () => {
    const harness = sidebarHarness();
    try {
      await harness.sidebar.showResults("course", "lab", 1);
      assert.ok(harness.view.webview.html.includes("Output for version 1"));
      harness.refresh();
      await flush();
      assert.ok(harness.view.webview.html.includes("Output for version 1"));
      harness.receive({ action: "version", version: 2 });
      await flush();
      assert.ok(harness.view.webview.html.includes("Output for version 2"));
      harness.receive({ action: "version", version: -1 });
      await flush();
      assert.ok(harness.view.webview.html.includes("Output for version 2"));
      assert.strictEqual(harness.focusCount(), 1);
    } finally { harness.sidebar.dispose(); }
  });

  test("late results from another lab cannot replace the current selection", async () => {
    let release!: (value: unknown) => void;
    const slow = new Promise<unknown>((resolve) => { release = resolve; });
    const item = (name: string) => ({
      course: { name: "course", display_name: "Course", semester: "Fall" },
      assessment: { name, display_name: name, start_at: null, due_at: null, end_at: null }, submissions: [],
    });
    const harness = sidebarHarness(async (_course, assessment) => assessment === "Slow Lab" ? slow : item(assessment));
    try {
      const first = harness.sidebar.showAssessment("course", "Slow Lab");
      await flush();
      await harness.sidebar.showAssessment("course", "Current Lab");
      release(item("Slow Lab"));
      await first;
      assert.ok(harness.view.webview.html.includes("Current Lab"));
      assert.ok(!harness.view.webview.html.includes("Slow Lab"));
    } finally { harness.sidebar.dispose(); }
  });
});
