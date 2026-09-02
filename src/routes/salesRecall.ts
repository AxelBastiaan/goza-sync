import { Router, Request, Response } from "express";
import { spawn, ChildProcess } from "child_process";
import fs from "fs";
import path from "path";

const router = Router();

const PROJECT_ROOT = path.join(__dirname, "..", "..");
const OUTPUT_DIR = path.join(PROJECT_ROOT, "sales-recall", "output");
const MAX_LOG_LINES = 200;

type JobStatus = "idle" | "running" | "success" | "error";

let jobStatus: JobStatus = "idle";
let startedAt: string | null = null;
let finishedAt: string | null = null;
let logLines: string[] = [];
let currentProcess: ChildProcess | null = null;

function appendLog(chunk: string) {
  for (const line of chunk.split(/\r?\n/)) {
    if (!line) continue;
    logLines.push(line);
  }
  if (logLines.length > MAX_LOG_LINES) {
    logLines = logLines.slice(logLines.length - MAX_LOG_LINES);
  }
}

// Generation takes several minutes (a live sweep across ~400 customers' Accurate
// history) — this starts it in the background and returns immediately. The
// frontend polls /status for progress instead of holding one long request open.
router.post("/generate", (_req: Request, res: Response) => {
  if (jobStatus === "running") {
    return res.status(409).json({ error: "A recall generation is already running." });
  }

  jobStatus = "running";
  startedAt = new Date().toISOString();
  finishedAt = null;
  logLines = [];

  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  currentProcess = spawn(npmCommand, ["run", "generate-sales-recall"], { cwd: PROJECT_ROOT });

  currentProcess.stdout?.on("data", (data) => appendLog(data.toString()));
  currentProcess.stderr?.on("data", (data) => appendLog(data.toString()));

  currentProcess.on("close", (code) => {
    jobStatus = code === 0 ? "success" : "error";
    finishedAt = new Date().toISOString();
    currentProcess = null;
  });

  currentProcess.on("error", (err) => {
    appendLog(`Failed to start: ${err.message}`);
    jobStatus = "error";
    finishedAt = new Date().toISOString();
    currentProcess = null;
  });

  res.status(202).json({ status: jobStatus, startedAt });
});

router.get("/status", (_req: Request, res: Response) => {
  res.json({ status: jobStatus, startedAt, finishedAt, log: logLines.slice(-40) });
});

// Lists whatever per-salesperson zips currently exist in sales-recall/output/,
// regardless of whether this server process is the one that generated them.
router.get("/files", (_req: Request, res: Response) => {
  if (!fs.existsSync(OUTPUT_DIR)) {
    return res.json([]);
  }

  const files = fs
    .readdirSync(OUTPUT_DIR)
    .filter((f) => f.toLowerCase().endsWith(".zip"))
    .map((filename) => {
      const stat = fs.statSync(path.join(OUTPUT_DIR, filename));
      return {
        filename,
        salesperson: filename.replace(/\.zip$/i, ""),
        sizeBytes: stat.size,
        generatedAt: stat.mtime.toISOString(),
      };
    })
    .sort((a, b) => a.salesperson.localeCompare(b.salesperson));

  res.json(files);
});

router.get("/download/:filename", (req: Request, res: Response) => {
  // Only ever serve a name that's actually a real file directly inside OUTPUT_DIR —
  // basename strips any path traversal (../) before it's used to build the real path.
  const filename = path.basename(req.params.filename);
  const filePath = path.join(OUTPUT_DIR, filename);

  if (!filename.toLowerCase().endsWith(".zip") || !fs.existsSync(filePath)) {
    return res.status(404).json({ error: "File not found" });
  }

  res.download(filePath, filename);
});

export default router;
