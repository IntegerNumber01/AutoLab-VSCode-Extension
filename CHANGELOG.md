# Changelog

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
