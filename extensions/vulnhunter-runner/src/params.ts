/**
 * 动态研判（含沙箱复现）是否开启：`mode=dynamic`（平台——执行环境就是沙箱，命令直接在里面跑），
 * 或独立使用时给了 `sandbox_cfg`（用户自备沙箱的 ssh 连接）。都没有 = 纯静态。
 */
export function isDynamic(params: Record<string, string>): boolean {
  return params.mode === "dynamic" || !!params.sandbox_cfg;
}
