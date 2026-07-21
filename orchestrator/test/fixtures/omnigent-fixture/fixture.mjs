// Deterministic fixture omnigent (architecture §4).
//
// Invoked exactly as the Dispatcher spawns the real binary:
//   omnigent run <agentDir> --no-session -p <prompt>
//
// It ignores the prompt and instead performs fully-scripted, deterministic
// side effects controlled by environment variables so a test can drive the
// entire legal dispatch transition sequence (success, false-success token,
// missing DB session, empty transcript, out-of-scope delta, no delta) without
// a live LLM:
//
//   OMNIGENT_DATA_DIR       chat.db location honored for DB-session writes
//   RICKGENT_TARGET_REPO    dispatcher-pinned run worktree for hostile direct modes
//   FIXTURE_STDOUT          transcript/stdout line to print (may be a success token)
//   FIXTURE_EXIT_CODE       process exit code (default 0)
//   FIXTURE_WRITE_DB        "1" → create a NEW conversation row (a DB session)
//   FIXTURE_CONV_ID         explicit conversation id (default: unique)
//   FIXTURE_TRANSCRIPT_ITEMS number of conversation_items to write (default 1)
//   FIXTURE_GIT_FILE        repo-relative file to write (empty → no git mutation)
//   FIXTURE_GIT_CONTENT     file content (default unique)
//   FIXTURE_GIT_COMMIT      "0" → stage only, else commit (default commit)
//   FIXTURE_FOREIGN_DATA_DIR   simulate a CONCURRENT foreign dispatch: write a
//                              conversation into this (shared) chat.db, distinct
//                              from OMNIGENT_DATA_DIR, during this run
//   FIXTURE_FOREIGN_CONV_ID    foreign conversation id (default: unique)
//   FIXTURE_FOREIGN_ITEMS      foreign conversation_items count (default 3)
//   FIXTURE_UNVERIFIABLE_PATHS comma-separated prompt paths that exit zero
//                              without producing completion evidence
//   FIXTURE_STUBBORN_RECORD    file prefix for a parent + descendant that
//                              both ignore SIGTERM until the dispatcher kills
//                              their complete process group
//   FIXTURE_DETACHED_RECORD    additionally spawn a new-session descendant
//                              that survives the outer CLI process group
//   FIXTURE_DETACHED_MARKER    file the detached descendant writes only after
//                              the outer CLI process has died

import { execFileSync, spawn as spawnProcess } from "child_process";
import { appendFileSync, writeFileSync, readFileSync, mkdirSync } from "fs";
import { dirname, join, isAbsolute } from "path";
import { insertConversation } from "./chat-db.mjs";

function env(name, fallback = "") {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

// Prompt-driven mode (build-loop tests). Each dispatch carries a per-ticket
// prompt via `-p <prompt>` naming the ticket's declared path; the fixture
// derives its per-ticket behavior from that path so ONE env config drives a
// multi-ticket build where selected tickets fail and the first safe worker can
// leave a nonterminal capture. A retained delta blocks later spawns in M1.
function promptArg() {
  const argv = process.argv;
  const i = argv.indexOf("-p");
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : "";
}

function pathFromPrompt(prompt) {
  const m = prompt.match(/[\w./-]+\.\w+/);
  return m ? m[0] : "";
}

function writeFixtureFile(repo, relPath, content) {
  const abs = isAbsolute(relPath) ? relPath : join(repo, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

function recordSpawn() {
  const record = env("FIXTURE_SPAWN_RECORD");
  if (!record) return;
  const bundle = process.argv[3] || "";
  let config = "";
  try {
    config = readFileSync(join(bundle, "config.yaml"), "utf-8");
  } catch {
    config = "";
  }
  mkdirSync(dirname(record), { recursive: true });
  let git = null;
  try {
    git = {
      head: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf-8" }).trim(),
      branch: execFileSync("git", ["symbolic-ref", "-q", "HEAD"], { encoding: "utf-8" }).trim(),
      status: execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], { encoding: "utf-8" }),
    };
  } catch {
    git = null;
  }
  writeFileSync(record, JSON.stringify({
    argv: process.argv.slice(2),
    cwd: process.cwd(),
    bundle,
    config,
    git,
  }));
}

function stubbornMode(record) {
  const role = env("FIXTURE_STUBBORN_ROLE", "parent");
  mkdirSync(dirname(record), { recursive: true });
  process.on("SIGTERM", () => {
    appendFileSync(`${record}.signals`, `${role}:SIGTERM\n`);
  });
  writeFileSync(`${record}.${role}.pid`, String(process.pid));

  if (role === "detached") {
    const outerPid = Number(env("FIXTURE_OUTER_PID"));
    const marker = env("FIXTURE_DETACHED_MARKER");
    let marked = false;
    setInterval(() => {
      if (marked || !marker || !Number.isSafeInteger(outerPid) || outerPid <= 0) return;
      try {
        process.kill(outerPid, 0);
      } catch (error) {
        if (error?.code !== "ESRCH") return;
        writeFixtureFile(process.cwd(), marker, `detached descendant ${process.pid} survived outer ${outerPid}\n`);
        marked = true;
      }
    }, 10);
  }

  if (role === "parent") {
    spawnProcess(process.execPath, [process.argv[1]], {
      stdio: "ignore",
      env: {
        ...process.env,
        FIXTURE_SPAWN_RECORD: "",
        FIXTURE_REQUIRE_NO_SESSION: "0",
        FIXTURE_STUBBORN_ROLE: "descendant",
      },
    });
    const detachedRecord = env("FIXTURE_DETACHED_RECORD");
    if (detachedRecord) {
      const detached = spawnProcess(process.execPath, [process.argv[1]], {
        stdio: "ignore",
        detached: true,
        cwd: process.cwd(),
        env: {
          ...process.env,
          FIXTURE_SPAWN_RECORD: "",
          FIXTURE_REQUIRE_NO_SESSION: "0",
          FIXTURE_STUBBORN_RECORD: detachedRecord,
          FIXTURE_STUBBORN_ROLE: "detached",
          FIXTURE_OUTER_PID: String(process.pid),
        },
      });
      detached.unref();
    }
  }

  // Both processes intentionally keep the event loop live after SIGTERM.
  setInterval(() => {}, 1_000);
}

function emitFloodOutput() {
  // FIXTURE_FLOOD_BYTES: when set to a positive integer, emit that many bytes
  // to BOTH stdout and stderr as part of the dispatch.  This is used by the
  // t23 concurrency corpus output-flood scenario to prove the production
  // AttemptRunner dispatch path (via the Docker containment backend) handles
  // a large volume of output through the real production path.  The output is
  // emitted BEFORE the scope file write so the dispatch produces the flood
  // while still completing successfully (writing the scope file + DB session).
  const floodBytes = parseInt(env("FIXTURE_FLOOD_BYTES", "0"), 10);
  if (!Number.isSafeInteger(floodBytes) || floodBytes <= 0) return;
  const stdoutPattern = Buffer.from("STDOUT|0123456789abcdef|\n", "ascii");
  const stderrPattern = Buffer.from("STDERR|fedcba9876543210|\n", "ascii");
  let written = 0;
  while (written < floodBytes) {
    const remaining = floodBytes - written;
    const len = Math.min(stdoutPattern.length, remaining);
    process.stdout.write(stdoutPattern.subarray(0, len));
    process.stderr.write(stderrPattern.subarray(0, len));
    written += len;
  }
}

function promptMode() {
  const prompt = promptArg();
  process.stdout.write(env("FIXTURE_STDOUT", "fixture worker transcript line") + "\n");

  const relPath = pathFromPrompt(prompt);
  const repo = process.cwd();
  const failPaths = env("FIXTURE_FAIL_PATHS")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const unverifiablePaths = env("FIXTURE_UNVERIFIABLE_PATHS")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (!relPath || !repo) {
    // Nothing to write — behave as a no-delta failure.
    process.exit(1);
  }

  if (failPaths.includes(relPath)) {
    // Failing ticket: leave an unstaged in-scope change for quarantine and
    // exit non-zero. The fixture never stages or commits capture-mode work.
    writeFixtureFile(repo, relPath, `partial work for ${relPath}\n`);
    process.exit(1);
  }

  if (unverifiablePaths.includes(relPath)) {
    // Explicit false-success fixture: transport exits zero, but there is no DB
    // session, transcript, commit, or in-scope delta for the oracle to verify.
    process.exit(0);
  }

  // Emit flood output (if configured) BEFORE writing the scope file so the
  // dispatch produces a large volume of output through the production path
  // while still completing successfully.
  emitFloodOutput();

  // Succeeding ticket: DB session + non-empty transcript + unstaged in-scope delta.
  const dataDir = env("OMNIGENT_DATA_DIR");
  if (dataDir) {
    const convId = `conv-${relPath.replace(/[^\w]/g, "_")}-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    insertConversation(dataDir, convId, 2, Date.now());
  }
  writeFixtureFile(repo, relPath, `feature implementation for ${relPath}\n`);
  process.exit(0);
}

function main() {
  recordSpawn();
  if (env("FIXTURE_REQUIRE_NO_SESSION") === "1" && !process.argv.slice(2).includes("--no-session")) {
    process.stderr.write("fixture requires authenticated direct --no-session dispatch\n");
    process.exit(64);
  }
  const stubbornRecord = env("FIXTURE_STUBBORN_RECORD");
  if (stubbornRecord) {
    stubbornMode(stubbornRecord);
    return;
  }
  if (env("FIXTURE_MODE") === "prompt") {
    promptMode();
    return;
  }
  const stdoutLine = env("FIXTURE_STDOUT", "fixture worker transcript line");
  process.stdout.write(stdoutLine + "\n");

  // --- DB session (conversations + conversation_items) ---
  if (env("FIXTURE_WRITE_DB") === "1") {
    const dataDir = env("OMNIGENT_DATA_DIR");
    if (dataDir) {
      const convId = env("FIXTURE_CONV_ID", `conv-${Date.now()}-${Math.floor(Math.random() * 1e9)}`);
      const items = parseInt(env("FIXTURE_TRANSCRIPT_ITEMS", "1"), 10);
      insertConversation(dataDir, convId, Number.isNaN(items) ? 1 : items, Date.now());
    }
  }

  // --- concurrent foreign dispatch writing to a shared store ---
  // Simulates a DIFFERENT dispatch that writes its own conversation into a
  // shared chat.db during this run. It must never be attributed to THIS
  // dispatch (VAL-DISPATCH-008, concurrent-foreign case).
  const foreignDir = env("FIXTURE_FOREIGN_DATA_DIR");
  if (foreignDir) {
    const foreignId = env("FIXTURE_FOREIGN_CONV_ID", `foreign-${Date.now()}-${Math.floor(Math.random() * 1e9)}`);
    const foreignItems = parseInt(env("FIXTURE_FOREIGN_ITEMS", "3"), 10);
    insertConversation(foreignDir, foreignId, Number.isNaN(foreignItems) ? 3 : foreignItems, Date.now());
  }

  // --- hostile direct-mode Git mutation (staging/commit rejection fixtures) ---
  const gitFile = env("FIXTURE_GIT_FILE");
  const repo = env("RICKGENT_TARGET_REPO") || env("FIXTURE_TARGET_REPO");
  if (gitFile && repo) {
    const abs = isAbsolute(gitFile) ? gitFile : join(repo, gitFile);
    mkdirSync(dirname(abs), { recursive: true });
    const content = env("FIXTURE_GIT_CONTENT", `fixture change ${Date.now()}\n`);
    writeFileSync(abs, content);
    const mutationMode = env("FIXTURE_GIT_COMMIT", "1");
    if (mutationMode !== "capture") {
      execFileSync("git", ["-C", repo, "add", "--", gitFile]);
    }
    if (mutationMode !== "0" && mutationMode !== "capture") {
      execFileSync("git", [
        "-C", repo,
        "-c", "user.email=fixture@rickgent.test",
        "-c", "user.name=Fixture Omnigent",
        "commit", "-m", "fixture worker commit",
      ]);
    }
  }

  const code = parseInt(env("FIXTURE_EXIT_CODE", "0"), 10);
  process.exit(Number.isNaN(code) ? 0 : code);
}

main();
