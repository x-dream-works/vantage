# Vantage

> 公司 AI 编程工具（Claude Code / Codex）的用量计量插件 — by dgcrane

公司为团队采购了 Claude Code / Codex 的付费额度。Vantage 是这些额度的**计量表**——像水表电表一样记录「用了多少」，汇总到公司用量看板，用于续费和资源调配决策。

代码完全开源（本仓库），本地运行的代码与仓库一致，可自行验证（见「如何自行验证」）；随时可彻底卸载（见「卸载」）。

## 采集范围（全量清单，与上传字段一一对应）

每个 AI 会话结束后，以下数据会 POST 到公司用量服务器：

| 类别 | 字段 | 说明 |
|---|---|---|
| 身份 | 姓名、部门、主机名 | 安装时你填写/确认，不登记邮箱 |
| 会话 | 工具、session_id、项目路径、开始/结束时间、时长、退出原因 | |
| 用量 | 消息数、工具调用数、输入/输出/合计 token、缓存 token 分档、分模型明细、使用的模型 | 纯计数 |
| **提问片段** | **首句提问 ≤300 字、末句提问 ≤120 字、会话标题 ≤60 字** | **自动脱敏后上传，见下节** |
| 分类 | 意图标签（debug / coding / chat 等，由关键词推断） | |
| 工具 | 各工具调用次数直方图（如 `{ Edit: 12, Bash: 5 }`） | |
| 文件 | 改动过的文件**名**（仅 basename，最多 8 个，无目录、无内容） | |
| 额度 | Codex 套餐类型与使用率 | 读本机 `~/.codex/auth.json` 调 OpenAI 官方接口，凭据只发往 chatgpt.com |

### 关于「提问片段」——请务必知情的一节

Vantage 会上传你会话**首句提问的前 300 字和末句提问的前 120 字**（脱敏后），以及会话标题。这是全表唯一涉及对话原文的地方，用途是把会话归类（编码 / 调试 / 文档），让公司知道额度花在什么类型的工作上。

脱敏规则（自动打码）：邮箱、常见 API 密钥前缀、JWT、URL 内嵌凭据、40 位以上长串。**脱敏是正则匹配，不是保证**——如果首句含内部系统名、业务数字等未命中规则的敏感内容，会照常上传。若不希望某个问题进入公司服务器，请换一台未安装 Vantage 的机器提问。

### 它不做的事

- 不截屏、不录屏、不录音
- 不记录键盘输入
- 不监控浏览器历史、不看你运行什么软件
- 不读取或上传你的文件内容和代码内容
- 不上传完整对话——只有上表的两段脱敏片段
- 不采集鼠标/键盘活跃度等任何行为考核类数据

## 常驻机制（主动说明，不做隐藏）

为了不漏采 Codex 数据（它没有会话结束钩子），Vantage 会安装以下触发器：

| 机制 | 作用 | 位置 |
|---|---|---|
| Claude Code 会话开始/结束钩子 | 采集本次会话 | 插件 hooks |
| 每小时计划任务 | 兜底扫描 Codex 会话 | macOS LaunchAgent / Linux systemd / Windows 任务计划 `VantageCodexHourly` |
| 登录自启脚本 | 开机即补采 | Windows 启动文件夹 `vantage-codex.vbs` |
| 隐藏窗口执行 | 防止每小时弹黑窗，非隐藏行为 | wscript |

## 静默自更新（主动说明，不做隐藏）

Vantage 每次会话开始时后台检查 marketplace 新版本（2 小时节流），自动更新。这意味着**公司可以随时通过发版改变上述采集行为**。你信任的锚点应该是：① 代码开源可 diff；② 「如何自行验证」的方法；③ 公司对数据用途的书面承诺——而不是「它现在没这么干」。

不想要自动更新，可设置环境变量 `VANTAGE_DISABLE_SELF_UPDATE=1` 关闭（副作用：不再获得修复与新功能）。

## 数据用途承诺

- 只用于团队整体的额度决策（续费、调配），**不用于个人考核**
- 数据不出公司用量服务器，不给任何第三方

## 安装（Claude Code 内执行）

前置：先装 [Git for Windows](https://git-scm.com/download/win)（一路默认下一步即可），装完**重启 Claude Code** 再执行下面的命令。

```text
/plugin marketplace add x-dream-works/vantage
/plugin install vantage@dgcrane
/reload-plugins
/vantage:setup
```

- 按 `/vantage:setup` 提示输入姓名（部门按公司通讯录自动填）
- 安装完成后**无需任何操作**，插件会在会话开始/结束时自动记录用量

### 杀毒软件报毒怎么办

每小时定时执行的隐藏脚本是杀软启发式（360 / 火绒 / Windows Defender）的常见误报对象。**默认建议：不处理**——误杀导致的采不全没有影响。

如果你想彻底消除误报，可以管理员身份运行以下脚本，把 Vantage 相关路径加入 Defender 排除：

```powershell
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\.claude\plugins\marketplaces\x-dream-works-vantage\plugin\vantage-whitelist.ps1"
```

> 但请注意：加入排除意味着这些目录今后**不再被病毒扫描**，请自行权衡，**不建议替他人运行此脚本**。第三方杀软（360 / 火绒等）同理，是否手动添加信任区由你自己决定：
> - `C:\Users\<用户名>\.vantage`
> - `C:\Users\<用户名>\.claude\plugins`
> - `C:\Users\<用户名>\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup\vantage-codex.vbs`

## 如何自行验证

1. **核对本地代码**：`diff -r ~/.vantage/agent <本仓库克隆后的 plugin/agent>`
2. **看待上传数据**：`~/.vantage/spool/` 下每个 JSON 就是一条待上传记录，可逐字段核对与本文清单是否一致（上传成功即删，历史动作见 agent.log）
3. **看运行日志**：`~/.vantage/agent.log` 记录每次采集 / 上传 / 自更新
4. **盯代码变更**：Watch 本仓库，自更新落地后可随时 diff

## 卸载

```text
/vantage:uninstall
```

然后 `/exit` 重新打开 Claude Code 让卸载彻底生效。
