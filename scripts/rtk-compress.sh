#!/bin/bash

# rtk-compress.sh: Intercepts long shell command outputs and filters out noise
# to preserve token limits for LLMs (Codex, Claude, Cursor, Antigravity).

# Check if rtk command exists
if command -v rtk &> /dev/null; then
  # Execute through rtk proxy
  exec rtk "$@"
else
  # Fallback filtering logic using a node script
  # Captures command output, runs regex and prints compressed output
  
  # Run command and capture output
  OUTPUT=$("$@" 2>&1)
  
  node -e '
    const raw = process.env.CMD_OUTPUT;
    if (!raw) {
      console.log("(Empty output)");
      process.exit(0);
    }
    
    let lines = raw.split("\n");
    let initialCount = lines.length;
    
    // 1. Remove duplicate subsequent lines
    let filtered = [];
    for (let i = 0; i < lines.length; i++) {
      if (i === 0 || lines[i] !== lines[i-1]) {
        filtered.push(lines[i]);
      }
    }
    
    // 2. Collapse maven, gradle or next build logs that are repetitive
    filtered = filtered.filter(line => {
      // Exclude generic debug / download info to save tokens
      if (line.includes("Downloading from") || line.includes("Downloaded from")) return false;
      if (line.includes("Progress (")) return false;
      return true;
    });

    // 3. Keep first 100 and last 100 lines if the output is massive
    if (filtered.length > 200) {
      const firstPart = filtered.slice(0, 100);
      const lastPart = filtered.slice(filtered.length - 100);
      console.log(firstPart.join("\n"));
      console.log(`\n... [RTK Fallback: Compressed ${initialCount - 200} lines of redundant output] ...\n`);
      console.log(lastPart.join("\n"));
    } else {
      console.log(filtered.join("\n"));
    }
  '
fi
