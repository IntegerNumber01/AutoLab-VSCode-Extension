import * as assert from "assert";
import * as fs from "fs";
import * as http from "http";
import type { AddressInfo } from "net";
import * as os from "os";
import * as path from "path";
import { AutolabApi } from "../api";

suite("Autolab API client", () => {
  test("uses bearer authentication and refreshes once after a 401", async () => {
    let requestCount = 0;
    const server = await startServer((request, response) => {
      requestCount += 1;
      if (request.headers.authorization === "Bearer expired-token") {
        json(response, 401, { error: "OAuth2 authorization failed" });
        return;
      }
      assert.strictEqual(request.headers.authorization, "Bearer refreshed-token");
      json(response, 200, [{
        name: "course",
        display_name: "Course",
        semester: "Fall 2026",
        late_slack: 0,
        grace_days: 0,
        auth_level: "student",
      }]);
    });

    try {
      let refreshRequested = false;
      const api = new AutolabApi(server.url, async (forceRefresh) => {
        refreshRequested ||= Boolean(forceRefresh);
        return forceRefresh ? "refreshed-token" : "expired-token";
      });
      const courses = await api.getCourses();
      assert.strictEqual(courses[0].name, "course");
      assert.strictEqual(requestCount, 2);
      assert.strictEqual(refreshRequested, true);
    } finally {
      await server.close();
    }
  });

  test("preserves a server-provided attachment filename and bytes", async () => {
    const server = await startServer((_request, response) => {
      response.writeHead(200, {
        "Content-Type": "application/zip",
        "Content-Disposition": "attachment; filename*=UTF-8''starter%20files.zip",
      });
      response.end(Buffer.from([1, 2, 3, 4]));
    });

    try {
      const api = new AutolabApi(server.url, async () => "token");
      const attachment = await api.downloadHandout("course", "lab");
      assert.strictEqual(attachment.kind, "file");
      if (attachment.kind === "file") {
        assert.strictEqual(attachment.filename, "starter files.zip");
        assert.deepStrictEqual([...attachment.data], [1, 2, 3, 4]);
      }
    } finally {
      await server.close();
    }
  });

  test("returns submissions newest first whatever order the server used", async () => {
    const server = await startServer((_request, response) => {
      json(response, 200, [
        { version: 2, filename: "b.zip", created_at: "2026-08-02T00:00:00Z", scores: {} },
        { version: 5, filename: "e.zip", created_at: "2026-08-05T00:00:00Z", scores: {} },
        { version: 1, filename: "a.zip", created_at: "2026-08-01T00:00:00Z", scores: {} },
      ]);
    });

    try {
      const api = new AutolabApi(server.url, async () => "token");
      const submissions = await api.getSubmissions("course", "lab");
      assert.deepStrictEqual(submissions.map((item) => item.version), [5, 2, 1]);
    } finally {
      await server.close();
    }
  });

  test("requests feedback for the named problem", async () => {
    let requestedUrl = "";
    const server = await startServer((request, response) => {
      requestedUrl = request.url ?? "";
      json(response, 200, { feedback: "All tests passed." });
    });

    try {
      const api = new AutolabApi(server.url, async () => "token");
      const feedback = await api.getFeedback("15-213", "lab 1", 4, "Correctness/Style");
      assert.strictEqual(feedback, "All tests passed.");
      assert.strictEqual(
        requestedUrl,
        "/api/v1/courses/15-213/assessments/lab%201/submissions/4/feedback?problem=Correctness%2FStyle",
      );
    } finally {
      await server.close();
    }
  });

  test("uploads the selected file as submission[file] multipart data", async () => {
    let requestBody = "";
    let contentType = "";
    const server = await startServer((request, response) => {
      contentType = request.headers["content-type"] ?? "";
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        requestBody = Buffer.concat(chunks).toString("utf8");
        json(response, 200, { version: 3, filename: "answer.txt" });
      });
    });
    const temporaryDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "autolab-api-test-"));
    const filename = path.join(temporaryDirectory, "answer.txt");
    await fs.promises.writeFile(filename, "student answer", "utf8");

    try {
      const api = new AutolabApi(server.url, async () => "token");
      const result = await api.submit("course", "lab", filename);
      assert.deepStrictEqual(result, { version: 3, filename: "answer.txt" });
      assert.match(contentType, /^multipart\/form-data; boundary=/);
      assert.match(requestBody, /name="submission\[file\]"/);
      assert.match(requestBody, /filename="answer.txt"/);
      assert.match(requestBody, /student answer/);
    } finally {
      await Promise.all([
        server.close(),
        fs.promises.rm(temporaryDirectory, { recursive: true, force: true }),
      ]);
    }
  });
});

async function startServer(
  handler: (request: http.IncomingMessage, response: http.ServerResponse) => void,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

function json(response: http.ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}
