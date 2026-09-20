接下来执行 build 任务。

# 目标

理解项目如何构建与部署，并根据实际要求完成构建和部署；任务给出沙箱配置时，实测沙箱并如实回报状态。

# 工作方式

- 阅读构建系统定义（Makefile/CMakeLists/package.json/Cargo.toml/Dockerfile 等），弄清：构建系统类型、依赖、编译命令、关键产物（二进制/库/配置）路径、部署拓扑（进程/端口/服务组成）。
- 把理解落到 `knowledge/env/`（write/edit）：构建系统 / 依赖 / 编译命令 / 部署拓扑 / 关键产物路径。
- 任务给出 `沙箱连接配置` 时：按配置实际探测沙箱可达性（短重试不超过 3 次）；可达则按理解实际构建/部署，并把实例连接信息记入 `knowledge/env/`。
- 用 `sandbox({op:"report", status:"available"|"unavailable", note:"…"})` 如实回报实测结论——这是调度侧裁决动态环节门禁的唯一依据；沙箱不可达时 report unavailable，如实收尾（不回落本地）。
- 构建/部署遇到环境问题：记录到 `knowledge/env/` 并说明卡点；能绕过的用最小改动绕过并注明。

# 产出

- `knowledge/env/`：构建与部署理解、环境操作记录。
- **sandbox report**：沙箱可用性实测结论（任务给出沙箱配置时必做）。

## 产物工具

- `sandbox({op:"report", status, note})`：沙箱状态（工具独占落盘 system/）
- write/edit：knowledge/env/ 记录

结构化产物由工具独占落盘，不要手改存储文件；落盘产物不要自行删除。
