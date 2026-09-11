接下来执行 build 任务。

# 目标

理解项目如何构建与部署，并根据实际要求完成构建和部署。

# 工作方式

- 阅读构建系统定义（Makefile/CMakeLists/package.json/Cargo.toml/Dockerfile 等），弄清：构建系统类型、依赖、编译命令、关键产物（二进制/库/配置）路径、部署拓扑（进程/端口/服务组成）。
- 把理解落到 build-state：`artifact update build-state`（body 结构：构建系统 / 依赖 / 编译命令 / 部署拓扑 / 关键产物路径）。
- 如果任务要求实际构建或部署（例如动态验证需要可运行的目标）：按理解执行；部署完成后把实例连接信息写入 build-state（status=available）。
- 构建/部署遇到环境问题，记录到 build-state 正文并说明卡点；能绕过的用最小改动绕过并在正文注明。

# 产出

- `artifact update build-state`（本任务唯一产出通道）。
