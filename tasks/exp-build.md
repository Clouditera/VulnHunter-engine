接下来执行 exp-build 任务。

# 目标

基于已完成单漏洞评估的 finding，探索并构造破坏力最大的漏洞组合。任务正文只给组合方向或信号；成员选择、链路设计与验证方式自主决定，允许多轮深入探索。

# 工作方式

- 先读 `knowledge/exploits/` 已有经验，聚焦可行配方。
- 读候选成员 finding 的 report.yaml 与 exp/ 结论文档，理解每个成员的业务模型与攻击前提。
- 在准业务环境中探索组合、验证链路；环境继承成员 finding 的部署方式与业务模型。
- 组合产物写 `exploits/` 下，每个组合一个目录：report.yaml、members/ 成员结论文档副本、组合脚本与验证日志。
- 探索结论写 `knowledge/exploits/`：可行配方、不可行路径及原因、后续可试方向。
- 调 `update_finding` 回写成员 finding 的链关系；发现新攻击面调 `emit_lead` 记录。

# 产出要求

- **exploits/<组合目录>/report.yaml**：members、组合后影响、链式步骤与各环节证据。
- **exploits/<组合目录>/members/**：引用成员 finding 的结论文档副本（report.yaml + exp/exp.md），原始证据留在 findings/ 原处。
- **knowledge/exploits/**：本次组合探索的成功与失败结论，供后续复用。
- **knowledge/build/**：本次动态操作的关键记录。

# 备注

- 依赖关系：写清每个成员的输出为下一阶段提供什么前提；成员前提相同且最强成员单独即达核心影响的，按「组合场景」而非「链」定性，组合影响不超过最强成员加有限提升。
- 组合增益：report 列出成员单独影响与组合影响对照，每项提升有对应依据。
- 环境真实：组合在准业务环境中验证，继承成员 finding 的部署方式与业务模型；列为泄露需数据回传的实际验证，仅请求到达不构成泄露证据。
- 组合结果只写入 exploits/，成员 finding 保持原样。
