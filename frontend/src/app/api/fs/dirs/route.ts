import { NextResponse } from "next/server";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  let targetPath = searchParams.get("path");

  if (!targetPath || !targetPath.trim()) {
    targetPath = process.cwd();
  }

  if (targetPath.startsWith("~")) {
    targetPath = path.join(os.homedir(), targetPath.slice(1));
  }

  try {
    const resolvedPath = path.resolve(targetPath);
    const stat = await fs.stat(resolvedPath);

    if (!stat.isDirectory()) {
      return NextResponse.json({ error: "Path is not a directory" }, { status: 400 });
    }

    const entries = await fs.readdir(resolvedPath, { withFileTypes: true });
    const directories: string[] = [];

    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith(".")) {
        directories.push(entry.name);
      }
    }

    directories.sort((a, b) => a.localeCompare(b));
    const parentPath = path.dirname(resolvedPath);

    return NextResponse.json({
      currentPath: resolvedPath,
      parentPath: parentPath !== resolvedPath ? parentPath : null,
      homePath: os.homedir(),
      directories,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
