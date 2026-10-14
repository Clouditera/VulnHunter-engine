/**
 * Execution environment seam (docs/engine-design.md §9: the "sandbox" replacement point).
 *
 * By default the agent's file and shell tools act on the machine the engine runs on. With a
 * `RunEnv` they act on another machine — a task's run sandbox — through an `ExecutionEnv`
 * (pi-env's `RemoteExecutionEnv`, or anything with the same interface). The engine does not know
 * the transport.
 *
 * Only `read`, `write`, `edit` and `bash` are rebound: they are Pi's default tool set, and the
 * engine's nodes do not enable `grep`, `find` or `ls`. A path under one of `localRoots` is served
 * by the engine's own machine, because that is where its state lives (the workspace directory:
 * knowledge/, findings/, system/); every other path, and every command, runs in the environment.
 * The environment is never handed the engine's own process environment: the engine holds
 * credentials that must not reach the machine running untrusted code.
 */

import { constants } from "node:fs";
import { access as fsAccess, mkdir as fsMkdir, readFile as fsReadFile, writeFile as fsWriteFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import {
  createBashToolDefinition, createEditToolDefinition, createReadToolDefinition, createWriteToolDefinition,
  type BashOperations, type EditOperations, type ReadOperations, type ToolDefinition, type WriteOperations,
} from "@earendil-works/pi-coding-agent";
import { BACKGROUND_CONTEXT, withAbortSignal, type Context } from "@earendil-works/chord/context";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";

export interface RunEnv {
  /** Where the agent's commands and project files live. */
  env: ExecutionEnv;
  /** Absolute directories the engine serves itself; everything else goes to `env`. */
  localRoots: readonly string[];
}

type Failure = { message: string; code?: string };

/** Throws the way Node's fs does, so the tools' error text and `aborted` / `timeout:<n>` handling stay as they are. */
function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: Failure }): T {
  if (result.ok) return result.value;
  throw Object.assign(new Error(result.error.message), result.error.code ? { code: result.error.code } : {});
}

const contextOf = (signal?: AbortSignal): Context => (signal ? withAbortSignal(signal, BACKGROUND_CONTEXT) : BACKGROUND_CONTEXT);

function localOperations() {
  return {
    readFile: (path: string) => fsReadFile(path),
    access: (path: string) => fsAccess(path, constants.R_OK),
    writeFile: (path: string, content: string) => fsWriteFile(path, content, "utf-8"),
    mkdir: (dir: string) => fsMkdir(dir, { recursive: true }).then(() => undefined),
  };
}

function remoteOperations(env: ExecutionEnv) {
  const ctx = BACKGROUND_CONTEXT;
  return {
    readFile: async (path: string) => Buffer.from(unwrap(await env.readBinaryFile(path, ctx))),
    access: async (path: string) => { unwrap(await env.fileInfo(path, ctx)); },
    writeFile: async (path: string, content: string) => unwrap(await env.writeFile(path, content, ctx)),
    mkdir: async (dir: string) => unwrap(await env.createDir(dir, { recursive: true }, ctx)),
  };
}

/** Tool definitions that replace the built-in `read`, `write`, `edit` and `bash` for this session. */
export function envToolDefinitions(cwd: string, run: RunEnv): ToolDefinition[] {
  const roots = run.localRoots.map((root) => resolve(root));
  const isLocal = (path: string) => roots.some((root) => path === root || path.startsWith(root + sep));
  const local = localOperations();
  const remote = remoteOperations(run.env);
  const pick = (path: string) => (isLocal(path) ? local : remote);

  const read: ReadOperations = { readFile: (p) => pick(p).readFile(p), access: (p) => pick(p).access(p) };
  const write: WriteOperations = { writeFile: (p, content) => pick(p).writeFile(p, content), mkdir: (d) => pick(d).mkdir(d) };
  const edit: EditOperations = { readFile: read.readFile, access: read.access, writeFile: write.writeFile };
  const bash: BashOperations = {
    exec: async (command, commandCwd, { onData, signal, timeout }) => {
      const result = await run.env.exec(command, {
        cwd: commandCwd,
        ...(timeout === undefined ? {} : { timeout }),
        onOutput: (text) => onData(Buffer.from(text)),
      }, contextOf(signal));
      return { exitCode: unwrap(result).exitCode };
    },
  };

  return [
    createReadToolDefinition(cwd, { operations: read }),
    createWriteToolDefinition(cwd, { operations: write }),
    createEditToolDefinition(cwd, { operations: edit }),
    createBashToolDefinition(cwd, { operations: bash }),
  ] as unknown as ToolDefinition[];
}
