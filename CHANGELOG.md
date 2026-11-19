# Changelog

## Unreleased

- Open downloaded labs automatically in the current workspace, preserving the development host and restoring lab selection across workspace changes.
- Activate from lab metadata and detect opened or moved lab folders without depending on course discovery.
- Move lab details, scores, submission versions, and feedback into the Autolab sidebar; open run results automatically after submission.
- Link recognized compiler and traceback locations to local source files and show explicit compiler errors and warnings in Problems with their submission version.
- Show failing autograder tests as a flat list with expected and actual values, and link each one to the method it exercises (also listed in Problems). The full log is collapsed beneath.
- Split the extension across both sidebars: Account and Labs stay in the Autolab activity bar on the left, while Lab Details & Feedback and Run History open in a **Current Lab** container in the right-hand (secondary) sidebar, so the Explorer stays usable beside the feedback. Requires VS Code 1.106 or later.
- Run History, the status bar, and Submit now follow the lab shown in Lab Details.
- Removed the duplicate in-page Refresh buttons; the view toolbar's Refresh remains.
- Bounded API and attachment response sizes and kept request deadlines active through body consumption; cross-origin HTTP redirects now fail closed.
- Hardened ZIP and tar extraction with entry, path-depth, decompression, expanded-size, and central-directory limits.
- Made connection and exclusion settings immune to workspace overrides, and made secret, metadata, and editor-configuration exclusions mandatory for generated submissions.
- Validated API response shapes at runtime, escaped submission versions in webviews, and restricted OAuth/external URLs to safe destinations.

## 0.3.0

- Kept working when the OAuth application is registered without the `user_courses` scope. Course and assessment listings are the only endpoints that require it, so the extension now falls back to labs the student names instead of failing to load.
- Added `autolab.courses`, plus the **Add Lab by URL** and **Remove Labs Added by URL** commands, for naming a lab from its Autolab page URL or the `COURSE/LAB` shorthand.
- Filled a manually added lab's display name, dates, and category from `assessments/:name`, which returns the same fields the assessment index would have.
- Took problem names and maximum scores from the assessment's `max_scores` when the problems endpoint is unavailable, so the results panel still shows scores out of their maximum.
- Fell back to the Autolab web page for handouts and writeups the API refuses, instead of failing the download.
- Reported what could not be loaded in the Labs view, distinguishing a missing scope from a failed request.

## 0.2.0

- Replaced the `adm-zip` dependency with a self-contained ZIP writer and reader built on Node's `zlib`, so packaging and extraction never invoke an operating-system archiver and behave identically on Windows, macOS, and Linux.
- Preserved Unix permission bits through both packaging and extraction, and inferred the executable bit from a `#!` line on Windows so submitted scripts stay runnable.
- Verified every extracted entry's CRC-32 and continued to reject traversal paths, absolute paths, and symlinks.
- Added ZIP64 support for archives past the 4 GB size and offset limits.
- Fetched autograder feedback for every problem instead of only the first, and rendered the trailing autograder JSON summary as a score and stage table.
- Added submission version switching and a refresh that keeps the selected version inside the results panel.
- Added an optional Labs grouping by status: To do, Awaiting score, Graded, Not open yet, Closed.
- Added a pre-submission check for closed handins and a confirmation when a lab is already past its due date.
- Remembered the packaging format per lab after a successful submission.
- Added a short, cancellable poll after submitting to an autograded lab so the score appears on its own.
- Sorted submissions newest-first regardless of server ordering, raised the handout download timeout, and tolerated a failing problems lookup.
- Showed local handout and writeup filenames, attempt counts, and a "View on Autolab" action in the lab panel.

## 0.1.0

- Added guided server, public-client, and workspace setup.
- Added Autolab device authorization and secure refresh-token storage.
- Added course and assessment browsing with due dates, submission state, and scores.
- Added safe handout/writeup download and archive extraction without overwriting student work.
- Added dedicated lab-window detection, ZIP/tar.gz/file submissions, and submission confirmation.
- Added submission history, score tables, and autograder feedback panels.
- Added HTTPS enforcement, public-client diagnostics, tests, and administrator documentation.
