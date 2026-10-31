# dsh-quest-log · 任务台账

> 给 DeepSeek Harness 的「插话任务」记忆：Agent 在跑活，你插一句「顺便把 X 也改了」——这句话不再只是飘进上下文，而是记进当前会话的任务台账，Agent 每一步都看得到，活干完还会被追问一句「台账里还有未完成的」。

## 它解决什么

在 Agent 执行任务的过程中，用「插话发送」（steering）补充要求时，这些消息很容易被后续的工具输出淹没，尤其当一轮跑了很多步之后。任务台账把这些额外任务：

1. **记下来** —— 插话消息自动进台账（也可手动/由 Agent 添加）；
2. **一直摆出来** —— 未完成任务写进系统提示，每一步都可见；
3. **让 Agent 自己收尾** —— Agent 完成一项就调用工具标记 `done`；
4. **轮末催一遍** —— 每轮结束若还有未完成任务，自动让本轮继续，直到台账清空或达到续跑上限。

## 功能

### 侧边栏面板

- 侧边栏「任务台账」图标打开主面板，按**当前会话**展示台账；
- 新增任务（标题 + 可选说明，Enter 直接提交）；
- 勾选完成 / 取消完成、编辑标题与说明、删除任务、一键清空已完成；
- 筛选「全部 / 未完成 / 已完成」，实时显示未完成与已完成数量；
- 面板每 1.5 秒轮询宿主，Agent 工具或插话捕获造成的变化会自动出现。

### Agent 工具

| 工具 | 作用 |
| --- | --- |
| `quest_log_list` | 查看台账（可按 open/done 过滤），拿到任务 id |
| `quest_log_add` | 添加一条任务（用户插话带来的额外任务） |
| `quest_log_update` | 改标题/说明，或 `status=done` 标记完成 |
| `quest_log_remove` | 删除任务（任务被用户取消时） |

面板与工具调用的是同一套宿主操作，行为一致。

### 自动捕获插话

用户的消息以「插话」（steering）方式进入 Agent 的当前一轮时（会话日志里是 `agent/inbox/spliced`、`target = next-step`），插件自动把消息文本记成一条来源为「插话」的任务，并带上原始消息 id 做去重。

### 变动注入

在面板上新增、修改、完成、删除任务时，如果对应 Agent 正在运行，插件用 `agent.inject()` 把一条简短的变动上下文送进它的下一步（不唤醒空闲 Agent——空闲时下一轮的系统提示自然会带上最新台账）。

### 轮末检查与续跑

等 Agent 真正空闲（`agent/status === 'idle'`）、本轮正常结束（`turn/end` 原因为 `completed`）之后检查台账：仍有未完成任务时，先把会话日志刷到持久层（`sessions.flush`），再用 `agent.followup()` 开下一轮，把「还有 N 项未完成」的清单交给 Agent。

> 这里刻意不用 `agent/turn-stopping` 里 `steer`：那样会在同一个 turn 里无限追加 step；宿主自己的「自动开新一轮」（dsh-goal-round-driver）同样是在 idle 之后 `followup`。

为避免死循环：

- 同一会话最多自动续跑 `maxAutoRounds` 次（默认 3）；
- 用户发来新的用户消息、或台账清空时，续跑计数清零；
- 上一轮不是正常完成（中断 / 报错 / 超 token）时不续跑；
- 已经被用户或其它插件排了下一轮消息时不插队；
- 子 Agent 会话不参与续跑。

## 安装

```bash
dsh plugin add @restregular/dsh-quest-log
```

或在 Harness 的「插件」页搜索 `@restregular/dsh-quest-log` 安装并启用。

## 配置

在 `cordis.patch.yml` 对应行里覆盖 `config`：

```yaml
- insert:
    - id: dsh-quest-log
      name: '@restregular/dsh-quest-log'
      config:
        captureSteering: true
        injectChanges: true
        promptLedger: true
        autoContinue: true
        maxAutoRounds: 3
        storeDir: ''
```

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `captureSteering` | boolean | `true` | 自动把插话消息记进台账 |
| `injectChanges` | boolean | `true` | 面板改动时把变动上下文注入运行中的 Agent |
| `promptLedger` | boolean | `true` | 在系统提示里展示未完成任务 |
| `autoContinue` | boolean | `true` | 轮末仍有未完成任务时自动续跑 |
| `maxAutoRounds` | integer | `3` | 同一会话连续自动续跑上限，`0` 关闭 |
| `storeDir` | string | `''` | 台账目录，空 = `<用户目录>/.dsh/dsh-quest-log` |

## 数据

- 每个会话一个 JSON 文件：`~/.dsh/dsh-quest-log/<sessionId>.json`；
- 写入使用「临时文件 + rename」原子替换；
- 删除文件即可清空对应会话的台账（运行中的进程会重建空台账，重启后彻底生效）。

## 实现说明

- **宿主半**：`index.js` + `lib/store.js`（会话级存储）、`lib/routes.js`（面板回环 HTTP API）、`lib/tools.js`（Agent 工具）、`lib/render.js`（系统提示/续跑/变动文本）；
- **客户端半**：`client.js`，注册 `sidebar.panellist` 图标与 `main` 面板，样式只用 `--dsw-alias-*` 主题 token，浅色/深色跟随宿主；
- 面板 API 只接受本机回环连接；Agent 工具通过宿主 `exec.agent.session.header` 定位当前会话，不需要模型传 sessionId。

## 许可

MIT
