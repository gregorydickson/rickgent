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

import { execFileSync } from "child_process";
import { writeFileSync, mkdirSync } from "fs";
import { dirname, join, isAbsolute } from "path";
import { insertConversation } from "./chat-db.mjs";

function env(name, fallback = "") {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

function main() {
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
