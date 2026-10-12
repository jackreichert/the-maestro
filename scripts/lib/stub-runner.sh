#!/bin/sh
# Test support (see stub-bin.ts). A stub's path is a symlink to this file; the stub's own script sits beside it as `<path>.stub`.
# Run it through the interpreter named on its shebang line, so a freshly written file is only ever read, never executed:
# macOS scans each newly written executable on its first run, which takes over a minute under load.
stub="$0.stub"
IFS= read -r line < "$stub"
exec "${line#??}" "$stub" "$@"
