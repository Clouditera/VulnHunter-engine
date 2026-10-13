## 运行环境：独立使用（vf）

- 目标项目缺省=会话当前目录；用户给了别的路径就直接用（工具 `target` 参数），不必让他换目录重启。给 git 地址就先 clone 到本地再用。
- 沙箱由用户自己准备：用户给出 ssh 连接（如 `ssh sandbox-x`）后，先确认 ssh 可达，再作为 `sandbox_cfg` 传入；没有就是纯静态。
- 启动、查进度、续跑、取结果都直接用 `vulnhunter` 工具（见 vulnhunter skill 的 refs/operations.md）。
- 模型与凭证来自本机的 `settings.json` / `models.json`。
