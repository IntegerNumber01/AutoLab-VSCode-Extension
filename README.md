# Autolab for VS Code

Autolab for VS Code gives students one place to see released labs, due dates, submission state, scores, and feedback. It downloads each lab into a designated workspace, opens it in a focused VS Code window, and submits it back to any compatible Autolab instance.

## Student workflow

1. Open the Autolab activity-bar icon and choose **Set up Autolab**.
2. Enter the Autolab server URL and the public client ID supplied by the instructor or administrator.
3. Choose a folder where courses and labs should be downloaded.
4. Open the activation page, paste the six-character code, and approve access.
5. Select a lab in **Labs** to see dates, status, scores, and handout details.
6. Download the lab. The extension offers to open it in a new VS Code window.
7. In that lab window, use the Autolab status-bar item or **Autolab: Submit Current Lab**.
8. Review the exact package summary, confirm once, and view scores and feedback in VS Code.

The extension never asks for an Autolab password or OAuth client secret. Sign-in happens only on the configured Autolab website.

## Features

- Works with arbitrary Autolab host URLs, including installations under a URL path.
- Manual/device authorization with a public OAuth client and five-second polling.
- Access and refresh tokens stored in VS Code `SecretStorage`, not in settings or lab files.
- All courses and released assessments grouped in the activity bar.
- At-a-glance **Not submitted**, **Submitted**, **Score unreleased**, and numeric score states.
- Handout and writeup downloads with support for files and external URLs.
- Safe ZIP, tar, tar.gz, and tgz extraction. Archive paths are validated, symlinks are ignored, and existing student files are never overwritten.
- A self-contained ZIP writer and reader built on Node's own `zlib`. No `zip`, `tar`, PowerShell, or other operating-system archiver is ever invoked, so Windows, macOS, and Linux produce identical archives.
- Per-lab `.autolab/assessment.json` metadata so a dedicated lab window knows where to submit.
- ZIP, tar.gz, or exact-file submission modes with configurable excludes and a final confirmation.
- Submission history, per-problem scores, and per-problem autograder feedback rendered in VS Code, with the trailing autograder JSON summary shown as a table.
- Optional grouping of the Labs view by status (To do, Awaiting score, Graded, Not open yet, Closed) instead of by course.
- A short, cancellable poll after each submission to an autograded lab, so the score appears without manual refreshing.
- Automatic access-token refresh and a clear reauthorization path after revocation.
- A reduced mode for OAuth applications registered without the `user_courses` scope, where labs are added by URL and everything except discovery still works.
- HTTPS required by default. Plain HTTP is available only as an explicit local-development option.

## Autolab administrator setup

The client-ID-only flow requires a **public/non-confidential** Doorkeeper application. A confidential application still requires its secret at `/oauth/token` and must not be distributed to students.

Create the application under **Manage Autolab → Manage API Applications** with:

- Redirect URI: `https://YOUR-AUTOLAB-HOST/device_flow_auth_cb`
- Scopes: `user_info user_courses user_scores user_submit`
- Confidential: `false`

Current upstream Autolab has a `confidential` field on `Doorkeeper::Application`, but its customized application form may not expose that field. If the checkbox is unavailable, an administrator can mark the newly created application public from the Rails console:

```ruby
app = Doorkeeper::Application.find_by!(uid: "THE_CLIENT_ID")
app.update!(confidential: false)
```

Distribute only `app.uid` (the client ID). Never distribute `app.secret`.

The redirect URI must match the Autolab host exactly. For an installation under `/autolab`, for example, use `https://example.edu/autolab/device_flow_auth_cb` and give students `https://example.edu/autolab` as the host.

Autolab builds the redirect URI itself during the device flow — `device_flow_activation#resolve` redirects to `/oauth/authorize` with `redirect_uri: device_flow_auth_cb_url` — so a redirect URI of any other shape, including a `vscode://` one, produces *"The requested redirect uri is malformed or doesn't match client redirect URI"* when the student enters their code. The extension cannot influence that value.

### Working without the `user_courses` scope

If the application is registered without `user_courses`, the extension still works in a reduced mode rather than failing. Autolab guards discovery behind that scope, but everything else is reachable:

| Feature | Endpoint | Scope |
| --- | --- | --- |
| Lab details, due dates, problem names, maximum scores | `assessments/:name` | none beyond a valid token |
| Submission history and per-problem scores | `submissions` | `user_scores` |
| Autograder feedback | `submissions/:version/feedback` | `user_scores` |
| Submitting | `submit` | `user_submit` |
| Listing courses and labs | `courses`, `assessments` | `user_courses` |
| Handout and writeup downloads | `handout`, `writeup` | `user_courses` |

In reduced mode students add each lab with **Autolab: Add Lab by URL** (or the `+` button in the Labs view), pasting the Autolab page URL for the lab. Problem names and maximum scores come from the assessment itself instead of `/problems`, and handouts and writeups open in the browser, where the student's normal Autolab session can still fetch them. Adding the scope restores automatic discovery with no other change.

See the official [Autolab API overview](https://docs.autolabproject.com/api-overview/), [API endpoint reference](https://docs.autolabproject.com/api-interface/), and [Autolab source](https://github.com/autolab/Autolab).

## Settings

| Setting | Purpose |
| --- | --- |
| `autolab.host` | Base URL for the Autolab instance. |
| `autolab.clientId` | Public, non-confidential OAuth application ID. |
| `autolab.workspaceFolder` | Parent directory for downloaded course/lab folders. |
| `autolab.groupBy` | Group the Labs view by `course` (default) or by `status`. |
| `autolab.courses` | Labs added by URL, used when the OAuth application cannot list courses. |
| `autolab.submissionFormat` | Ask each time, ZIP, tar.gz, or select one exact file. |
| `autolab.exclude` | Additional glob patterns left out of packaged folders. Built-in secret and metadata exclusions cannot be removed by a workspace. |
| `autolab.allowInsecureHttp` | Allows HTTP only for trusted local development. |

Autolab's assessment API does not report the configured handin filename/type rule. For that reason, the default submission setting asks students whether to create a ZIP, create a tar.gz, or submit an exact file. Instructors should state the required form in the writeup. After a successful submission the chosen format is recorded in the lab's own metadata and offered first the next time.

## Archiving

Submissions are packaged in-process. `src/zip.ts` implements the ZIP format directly on top of Node's `zlib`, covering deflate and store entries, UTF-8 filenames, ZIP64 sizes and offsets, CRC-32 verification on read, and Unix permission bits in the external attributes. Consequences worth knowing:

- No shell-out. The extension never calls `zip`, `Compress-Archive`, `ditto`, or `tar` from the operating system, so behaviour does not drift between a student on Windows and a grader on Linux.
- Executable bits survive. On macOS and Linux the file's real mode is stored. Windows has no executable bit, so a file starting with `#!` is stored as `0755` and everything else as `0644`, keeping submitted shell scripts runnable for the autograder.
- Entries are read and written one at a time, so a large handout costs only as much memory as its single biggest file.
- Extraction verifies every entry's CRC-32 and rejects absolute paths, `..` traversal, and symlinks before anything touches disk.

`tar.gz` submissions use the pure-JavaScript `tar` package, which likewise never invokes a system binary.

## Download layout

Labs are placed under:

```text
<workspace>/<course-name>/<assessment-name>/
```

Archives are retained under `.autolab/artifacts/`, and `.autolab/assessment.json` records only the server and assessment identity. It never contains access tokens, refresh tokens, passwords, or a client secret. The `.autolab/**` and `.vscode/**` folders, common environment files, and private-key formats are always excluded from generated submissions. Use exact-file mode if an assignment deliberately requires one protected file.

Re-downloading uses a missing-files-only policy. Existing source files are not replaced, even if a newer handout contains the same path.

## Development

```bash
npm install
npm run check-types
npm run lint
npm run compile
npm test
npm run test:extension
npm run package
```

Press `F5` in VS Code to launch the Extension Development Host.

`npm test` runs the platform-independent unit suite. `npm run test:extension` runs the same compiled tests in a VS Code Electron host and is useful in CI or local paths that the VS Code test launcher can quote correctly.

## Compatibility notes

- The extension targets VS Code 1.104 or later and current Autolab v1 API routes.
- Older Autolab installations that do not support non-confidential Doorkeeper clients need an Autolab upgrade or an administrator-side OAuth broker. The extension intentionally has no client-secret setting.
- Autolab currently returns one generalized feedback payload for a submission even though the endpoint accepts a problem name. The results panel therefore displays one autograder feedback section alongside the per-problem score table.
