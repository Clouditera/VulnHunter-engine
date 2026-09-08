# 模型评测交接文档（jarvy → sec，2026-09-08）

## 当前状态一句话

第一轮（模块级发现能力，9 用例 × 4 模型）已收官并出报告；第二轮（直觉评测，17 目标 × 4 模型）环境刚备好、冒烟验证通过，**未全量开跑**。

## 两轮评测的设计

### 第一轮（已完成，报告：evals/model-battle/results-phase-a.md）

- 用例：9 个真实 CVE（redis×5、vm2、sglang、lightllm、gogs），模块级 scope，3 轮累积式 hunt（goto 分支往返+摘要），思考档 high
- 结果：glm-5.2=7/9，glm-5.3=7/9，glm-5.3-flash=6/9，deepseek-v4-flash=7/9
- 产物：`vulnhunt-test:~/vulnforge-eval/out/phase-a/<model>/<case>/`

### 第二轮「直觉评测」（环境就绪，待全量跑）

- **测什么**：模型的安全直觉——给定漏洞附近的局部代码（≤3000 行），能否嗅出问题。**不测搜索能力**（GT 知情圈定 scope，这是有意设计）
- **测试集**：`evals/model-battle/intuition/intuition-set.json`，17 个（项目,版本,漏洞）：
  - redis 8.2.1 ×4（Lua 集群：49844/46817/46818/46819）
  - gogs 0.14.2 ×6（2026-06-19 披露批次）
  - vm2 3.10.3 ×3（ffh4/qvjj/hw58，注意版本是 3.10.3 不是 3.10.4）
  - mruby 3.3.0 ×4（array.c×2 同 scope 合并、codegen.c、vm.c）
- **流程**：无 init；每个 scope 会话 = hunt1 → compact（保留发现）→ hunt2 → compact → hunt3；静态直觉提示词（tasks/hunt-intuition.md：不编译不运行不连沙箱）；**思考档 max**（fish 裁定：新测试集上最高档）
- **统计**：每目标三项——目标漏洞是否发现（人工对照 manifest 里的 gt 字段）、总 token、HYP 数

## 基建布局（vulnhunt-test = 192.168.31.102）

- 引擎冻结快照：`~/vulnforge-eval/engine-frozen/`（.dist、models.json、tasks/、evals/——**与研发目录脱钩，改研发代码不影响评测**）
- 镜像：`vulnforge-target:{redis-8.2.1, gogs-0.14.2, vm2-3.10.3, mruby-3.3.0}` 都已建好
- 输出：`~/vulnforge-eval/out/intuition/<model>/<session>/`（HYP + _meta.json 含 usage）
- 磁盘看门狗：`~/vulnforge-eval/disk-watchdog.sh` 常驻（单容器写层 >20G 或宿主空闲 <10G 自动杀，日志 watchdog.log）——**不要停它**，磁盘满已经搞翻过两次

## 怎么跑

```bash
ssh vulnhunt-test
export ZAI_CODING_CN_API_KEY=<key> CLOUDROUTER_API_KEY=<key>   # 两个 key 在 ~/dev/llm/VulnHunter-engine/.env（本机 worktree）
nohup bash ~/vulnforge-eval/engine-frozen/evals/model-battle/intuition/eval-b.sh 6 > ~/vulnforge-eval/intuition.log 2>&1 &
# 参数1=容器并行数（建议 6，任务小）；参数2=模型过滤子串（可选）
# 有跳过逻辑：已完成的（项目,模型）自动跳过，可随时中断重跑
```

单组调试：`docker run` 参照 eval-b.sh 里的写法（--entrypoint node + 挂载 .dist/models.json/tasks/evals + -e EVAL_MODEL/EVAL_PROJECT）。

## 已踩过的坑（别再踩）

1. **deepseek 会脱稿搞动态验证**（自行 apt+编译 ASAN 版目标，刷出 101G 日志）——第一轮 R5 因此 0 产出；第二轮提示词已明确"纯静态"，若再犯就是行为结论，记录即可
2. deepseek 的两个兼容性坑已修：compact 上下文过小崩溃（驱动已容错）、pi 分支摘要的 developer role 被 cloudrouter 拒绝（models.json 里 compat.supportsDeveloperRole=false）
3. 磁盘是最大敌人：跑之前 `df -h /` 确认 >50G 空闲；vulnhunter-* 产品线镜像占 80G+，清理要问 fish
4. 容器命名 eval-b-<项目>-<模型>；结果没归档前别删容器（会话文件在容器里）

## 待办

1. **全量跑第二轮**：16 个容器（4 项目 × 4 模型），预计每个 30-90 分钟（max 档比 high 慢不少，redis 冒烟单会话 ~30 分钟）
2. **命中判定**：逐会话对照 manifest 的 gt 字段人工判定（同 scope 多洞的要分开判，如 J3 判 qvjj 和 hw58 各中否）
3. **出第二轮报告**：矩阵 + token + HYP 数 + 与第一轮对比（high→max 的变化、模块级→文件级的变化）
4. 遗留待定：第一轮 R5-deepseek 是否加静态约束重跑（fish 未拍板，可以先不管）

## 冒烟验证记录（2026-09-08 03:20 起）

flash@redis 单容器验证通过：scope 计算正确（1340 行全量/464 行全量）、compact 容错生效（"上下文过小"正常跳过）、R7 会话完成产 9 条 HYP + usage 0.4M 归档正常。冒烟容器可能还在跑 R6/R8/R9，直接让它跑完也算正式数据（有跳过逻辑不会重复）。
