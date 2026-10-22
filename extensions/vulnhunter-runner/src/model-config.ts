/**
 * 模型配置（fish 09-21）：按池分配 + 启动参数 + 运行中热切换。
 *
 * 单源：<workdir>/system/model.json（运行中切换工具写它、运行侧监听应用）。
 * 启动参数在 run 启动时并入该文件：params.model（全局）/ model_init / model_hunt / model_verify（按池）。
 * 语法 "provider/modelId[:thinking]"（同 settings subagents 风格）。
 * 生效：文件[池] → 文件.global → undefined（缺省走 settings.json 默认，保持旧行为）。
 */
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { AGENT_THINKING_LEVELS, type AgentThinkingLevel } from "./agent-model.ts";

export interface ModelSpec { provider: string; id: string; thinking?: AgentThinkingLevel }
export type ModelPool = "global" | "init" | "hunt" | "verify";
export type ModelConfig = Partial<Record<ModelPool, string>>;

export const MODEL_POOLS: ModelPool[] = ["global", "init", "hunt", "verify"];

export function parseModelSpec(spec: string): ModelSpec {
  const m = spec.trim().match(/^([^/:]+)\/([^:]+)(?::([A-Za-z]+))?$/);
  if (!m) throw new Error(`模型配置格式错误："${spec}"（应为 provider/model[:thinking]）`);
  const thinking = AGENT_THINKING_LEVELS.find((level) => level === m[3]);
  if (m[3] !== undefined && thinking === undefined) throw new Error(`不支持的 thinking level：${m[3]}`);
  return { provider: m[1], id: m[2], thinking };
}

const cfgPath = (workdir: string) => join(workdir, "system", "model.json");

export function readModelConfig(workdir: string): ModelConfig {
  try {
    const j = JSON.parse(readFileSync(cfgPath(workdir), "utf-8")) as Record<string, unknown>;
    const out: ModelConfig = {};
    for (const k of MODEL_POOLS) {
      const v = j[k];
      if (typeof v === "string" && v.trim()) out[k] = v.trim();
    }
    return out;
  } catch { return {}; }
}

/** 写入并合并（null/空串=清除该项）；返回新配置 */
export function writeModelConfig(workdir: string, patch: Partial<Record<ModelPool, string | null>>): ModelConfig {
  const cur = readModelConfig(workdir) as Record<string, unknown>;
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || String(v).trim() === "") delete cur[k];
    else cur[k] = String(v).trim();
  }
  mkdirSync(dirname(cfgPath(workdir)), { recursive: true });
  writeFileSync(cfgPath(workdir), JSON.stringify(cur, null, 2));
  return cur as ModelConfig;
}

/** 启动参数并入文件（只写显式给出的项；不指定不动已有文件） */
export function seedModelConfigFromParams(workdir: string, params: Record<string, string>): void {
  const patch: Partial<Record<ModelPool, string>> = {};
  if (params.model) patch.global = params.model;
  if (params.model_init) patch.init = params.model_init;
  if (params.model_hunt) patch.hunt = params.model_hunt;
  if (params.model_verify) patch.verify = params.model_verify;
  if (Object.keys(patch).length) writeModelConfig(workdir, patch);
}

/** 池 → 生效 spec（文件池项 → 文件 global → undefined=走 settings 默认） */
export function effectiveModelSpec(cfg: ModelConfig, pool: string): string | undefined {
  return cfg[pool as ModelPool] ?? cfg.global;
}

// ---- ModelRuntime 解析（按 engineDir 缓存；会话创建与热切换共用同一实例） ----
let runtimeCache: { engineDir: string; rt: Promise<ModelRuntime> } | null = null;
export function getModelRuntime(engineDir: string): Promise<ModelRuntime> {
  if (!runtimeCache || runtimeCache.engineDir !== engineDir) {
    runtimeCache = {
      engineDir,
      rt: ModelRuntime.create({
        authPath: join(engineDir, "auth.json"),
        modelsPath: join(engineDir, "models.json"),
      }),
    };
  }
  return runtimeCache.rt;
}

/** 解析 spec → Model 对象；未知 provider/模型 → 抛错（fail fast，不静默回退） */
export async function resolveModel(engineDir: string, spec: string): Promise<{ model: NonNullable<ReturnType<ModelRuntime["getModel"]>>; parsed: ModelSpec; runtime: ModelRuntime }> {
  const parsed = parseModelSpec(spec);
  const rt = await getModelRuntime(engineDir);
  const model = rt.getModel(parsed.provider, parsed.id);
  if (!model) throw new Error(`模型解析失败：未知模型 ${parsed.provider}/${parsed.id}（检查引擎 models.json 与拼写）`);
  return { model, parsed, runtime: rt };
}

// ---------------------------------------------------------------------------
// 运行中热切换：会话登记 + 变更应用 + 文件监听（可测纯逻辑，audit-lite 接线）
// ---------------------------------------------------------------------------

export interface LiveModelHost { id: string; setModel(spec: string): Promise<void> }

export interface LiveModelSwitch {
  /** 登记在跑会话（applied=创建时已用的 spec）；返回注销函数 */
  register(h: LiveModelHost, pool: () => string, applied: string | undefined): () => void;
  /** 检查配置并应用差异（在跑会话 setModel，下一轮请求生效） */
  apply(): Promise<void>;
  size(): number;
}

export function createLiveModelSwitch(opts: { read: () => ModelConfig; report?: (m: string) => void }): LiveModelSwitch {
  const handles = new Map<LiveModelHost, { pool: () => string; applied: string | undefined }>();
  let applying = false;
  return {
    register(h, pool, applied) {
      handles.set(h, { pool, applied });
      return () => { handles.delete(h); };
    },
    async apply() {
      if (applying || handles.size === 0) return;
      applying = true;
      try {
        const cfg = opts.read();
        for (const [h, e] of handles) {
          const want = effectiveModelSpec(cfg, e.pool());
          if (!want || want === e.applied) continue;
          try {
            await h.setModel(want);
            e.applied = want;
            opts.report?.(`模型热切换：${h.id} → ${want}`);
          } catch (err) { opts.report?.(`模型热切换失败：${h.id} ${String(err).slice(0, 120)}`); }
        }
      } finally { applying = false; }
    },
    size: () => handles.size,
  };
}

/** 模型文件监听：按引用计数启停（多阶段共享一个 timer）；变更时回调 */
export function createModelFileWatch(opts: { workdir: string; onChanged: () => void | Promise<void>; intervalMs?: number }): { acquire(): () => void } {
  let refs = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  let mtime = (() => { try { return statSync(cfgPath(opts.workdir)).mtimeMs; } catch { return 0; } })();
  return {
    acquire(): () => void {
      refs++;
      if (!timer) {
        timer = setInterval(() => {
          let m = 0;
          try { m = statSync(cfgPath(opts.workdir)).mtimeMs; } catch { /* 未建 */ }
          if (m && m !== mtime) { mtime = m; void opts.onChanged(); }
        }, opts.intervalMs ?? 15000);
        (timer as unknown as { unref?: () => void }).unref?.();
      }
      let done = false;
      return () => { if (done) return; done = true; refs--; if (refs <= 0 && timer) { clearInterval(timer); timer = null; } };
    },
  };
}
