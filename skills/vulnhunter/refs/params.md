# 参数参考

`vulnhunter({ op: "run", workflow, params: {…} })` 的 params 全部可选：

| 参数 | 默认 | 说明 |
|---|---|---|
| vuln_focus | 无（全方向） | 漏洞关注方向，如"内存安全与输入解析问题"；建议给 |
| sandbox_cfg | 无 | 沙箱 ssh 连接配置（如 `ssh sandbox-x`）；给了=研判含沙箱复现（dynamic-verify→ev-assess），不给=纯静态（static-verify） |
| skip_ev | 无 | 置 "1"=显式跳过 ev-assess：只做研判与沙箱复现，不做影响评估 |
| rounds | 无 | hunt 轮次显式封顶（优先于自动上限；自动硬上限 = clamp(5·log10(loc), 2, 15)） |
| chain_filter | 全部 | 每轮前 K 条 HYP 走研判链，限成本用（如 "2"） |
| chain_concurrency | 默认＝model_concurrency（未设时 3） | verify 并发数（缺省跟模型容量；dv/ev 段另受沙箱容量限） |
| model_concurrency | 3 | 模型容量许可（并发模型调用上限），限流用 |
| model | 无（→settings.json 默认） | 全局模型，语法 `provider/model[:thinking]`；启动时并入 `system/model.json`，运行中可用 `vulnhunter({op:"model"})` 热切 |
| model_init / model_hunt / model_verify | 无（→全局） | 按池模型覆盖（init / hunt / verify 三池）；不同池任务类型不同，可分池选模型 |
| hunt_coverage_threshold | 90 | hunt 停轮的靶内覆盖率阈值（%） |
| hunt_max_rounds | 5 | 自动硬上限系数 k：上限 = clamp(k·log10(loc), 2, 15)；显式 rounds 优先 |
| hunt_zero_rounds | 已废弃 | **deprecated**：不再参与停轮判定（由有效产出判定取代）；保留读取，显式传入仅打 warning |
| hunt_mode | 积累制 | "fresh"=每轮 hunt 从 init 重新开始（轮间零继承，靠磁盘 HYP 文件查重） |
| coverage_include | "."（全项目） | 覆盖率统计目标，逗号分隔相对路径（如 "proxy,vendor/mcmc"）；支持 `*` 通配（如 "*.c"）；统计口径=文本类文件（按内容判定，二进制不计）；落盘 .vulnforge/coverage.yaml |
| coverage_exclude | 无 | 覆盖率排除路径，逗号分隔（如 "vendor,t"）；支持 `*` 通配（如 "*.json"、"*.log"）；默认仅排点目录（.vulnforge/.git 等） |
| output_lang | zh-CN | 产物输出语言 |

## 参数怎么给（都带缺省，不是表单）

- **目标**：工具参数 `target`（缺省=会话当前目录）。引擎产物都写在目标目录的 `.vulnforge/` 下。
- **范围**：`coverage_include` / `coverage_exclude`——不填=全项目；收窄或排除只在项目偏大、或用户有明确偏好时才有必要。支持 `*` 通配（`*.json`、`src/*.c`），重叠处 exclude 赢；`.vulnforge` 和二进制文件自动不计。
- **方向**：`vuln_focus`——一句话；不填=全方向。
- **沙箱**：`sandbox_cfg`——要动态复现才用（先确认 ssh 可达）；不填=纯静态。
- **其余**（阈值、链并发、轮数、hunt_mode）：默认即可，属于试验/调优项，用户问起再解释。
