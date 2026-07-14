// Deterministic fixture omnigent (architecture §4).
//
// Invoked exactly as the Dispatcher spawns the real binary:
//   omnigent run <agentDir> -p <prompt>
//
// It ignores the prompt and instead performs fully-scripted, deterministic
// side effects controlled by environment variables so a test can drive the
// entire legal dispatch transition sequence (success, false-success token,
// missing DB session, empty transcript, out-of-scope delta, no delta) without
// a live LLM:
//
//   OMNIGENT_DATA_DIR       chat.db location honored for DB-session writes
//   FIXTURE_TARGET_REPO     git repo the "worker" mutates (write + add + commit)
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

import { execFileSync } from "child_process";
import { writeFileSync, mkdirSync } from "fs";
import { dirname, join, isAbsolute } from "path";
import { insertConversation } from "./chat-db.mjs";

function env(name, fallback = "") {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

// Prompt-driven mode (build-loop tests). Each dispatch carries a per-ticket
// prompt via `-p <prompt>` naming the ticket's declared path; the fixture
// derives its per-ticket behavior from that path so ONE env config drives a
// multi-ticket build where selected tickets fail and the rest complete.
function promptArg() {
  const argv = process.argv;
  const i = argv.indexOf("-p");
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : "";
}

function pathFromPrompt(prompt) {
  const m = prompt.match(/[\w./-]+\.\w+/);
  return m ? m[0] : "";
}

function commitFile(repo, relPath, content) {
  const abs = isAbsolute(relPath) ? relPath : join(repo, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  execFileSync("git", ["-C", repo, "add", "--", relPath]);
}

function promptMode() {
  const prompt = promptArg();
  process.stdout.write(env("FIXTURE_STDOUT", "fixture worker transcript line") + "\n");

  const relPath = pathFromPrompt(prompt);
  const repo = env("FIXTURE_TARGET_REPO") || env("PWD");
  const failPaths = env("FIXTURE_FAIL_PATHS")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (!relPath || !repo) {
    // Nothing to write — behave as a no-delta failure.
    process.exit(1);
  }

  if (failPaths.includes(relPath)) {
    // Failing ticket: leave an uncommitted in-scope change (salvageable) and
    // exit non-zero. No DB session, no commit → dispatch fails.
    commitFile(repo, relPath, `partial work for ${relPath}\n`);
    process.exit(1);
  }

  // Succeeding ticket: DB session + non-empty transcript + committed in-scope delta.
  const dataDir = env("OMNIGENT_DATA_DIR");
  if (dataDir) {
    const convId = `conv-${relPath.replace(/[^\w]/g, "_")}-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    insertConversation(dataDir, convId, 2, Date.now());
  }
  commitFile(repo, relPath, `feature implementation for ${relPath}\n`);
  execFileSync("git", [
    "-C", repo,
    "-c", "user.email=fixture@rickgent.test",
    "-c", "user.name=Fixture Omnigent",
    "commit", "-m", `fixture worker commit: ${relPath}`,
  ]);
  process.exit(0);
}

function main() {
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

  // --- git mutation (deterministic write + add + commit) ---
  const gitFile = env("FIXTURE_GIT_FILE");
  const repo = env("FIXTURE_TARGET_REPO");
  if (gitFile && repo) {
    const abs = isAbsolute(gitFile) ? gitFile : join(repo, gitFile);
    mkdirSync(dirname(abs), { recursive: true });
    const content = env("FIXTURE_GIT_CONTENT", `fixture change ${Date.now()}\n`);
    writeFileSync(abs, content);
    execFileSync("git", ["-C", repo, "add", "--", gitFile]);
    if (env("FIXTURE_GIT_COMMIT", "1") !== "0") {
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
