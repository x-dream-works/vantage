# Vantage

> 团队 AI 编程助手使用情况的制高点视野 — by dgcrane

Vantage 员工端插件，用于计量 **Claude Code** 与 **Codex** 的用量（token、调用次数、模型），汇总到公司用量看板，帮助团队掌握额度消耗、避免中途断量、为续费和资源调配提供依据。

> **这是什么**：一个用量计，类似水表电表——公司采购了 Claude Code / Codex 的付费额度，Vantage 负责把这些额度的使用量记账并汇总。**它不是行为监控：不读屏幕、不记录键盘、不读你的文件、不保存对话内容**，只在会话开始/结束时记录「这次用了多少 token、哪个模型」之类的用量数字。

服务端仓库：[x-dream-works/vantage](https://github.com/x-dream-works/vantage)

---

## 员工安装（Claude Code 内执行）

```text
/plugin marketplace add x-dream-works/vantage
/plugin install vantage@dgcrane
/reload-plugins
/vantage:setup
```

- 按 `/vantage:setup` 提示输入姓名（部门按公司通讯录自动填）
- 安装完成后**无需任何操作**，插件会在会话开始/结束时自动记录用量

### Windows 用户注意

Vantage 靠一个「每小时跑一次」的定时任务来计量 Codex 用量。这类定时执行的脚本常被 360、火绒、Windows Defender 等**启发式杀毒软件误判为可疑而拦截**，导致用量采不全。setup 完成后，可**自愿**以管理员身份运行以下脚本，把 Vantage 目录加入 Defender 排除项以避免误杀：

```powershell
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\.claude\plugins\marketplaces\x-dream-works-vantage\plugin\vantage-whitelist.ps1"
```

> 说明：加入排除项**只是为了避免杀毒软件误杀定时任务**，不是为了隐藏 Vantage——它本就是公司 IT 公开部署的工具。不运行此脚本也能用，只是 Codex 用量可能采不全。

如果用的是 360 等第三方杀软，请在对应软件中把以下路径加入信任区（同理，防误杀）：
- `C:\Users\<用户名>\.vantage`
- `C:\Users\<用户名>\.claude\plugins`
- `C:\Users\<用户名>\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup\vantage-codex.vbs`

---

## 采集范围

| 类别 | 字段 |
|---|---|
| 身份 | 姓名、部门、主机名（不登记邮箱） |
| 会话 | 工具、session_id、项目路径、开始/结束时间、时长 |
| 用量 | 消息数、输入/输出/合计 token、分模型明细、使用的模型 |
| 额度 | Codex 当前额度使用率、套餐类型 |
| 分类标签 | 仅记录脱敏后的首句提问，用于把用量归类（如编码 / 调试 / 文档），**不保存任何对话内容** |

**隐私**：Vantage 只计量用量，**不保存对话内容、不截屏、不读文件**。首句提问仅作为分类标签，且会自动脱敏（邮箱 / 密钥 / JWT / URL 凭据 / 长 token 串会被打码）。任何人无法通过 Vantage 还原你聊过什么。

---

## 触发机制

| 工具 | 计量时机 |
|------|----------|
| Claude Code | 会话开始 / 结束时（Claude Code 插件钩子，只记用量） |
| Codex | 每小时自动统计一次用量（macOS LaunchAgent / Linux systemd / Windows 计划任务） |

---

## 管理员预置

编辑 `plugin/vantage.defaults.json`，填入后端地址与上传密钥：

```json
{
  "server_url": "https://vantage.dgcrane.com",
  "token": "<专属密钥>"
}
```

员工 setup 时无需手动填写。

---

## 卸载

```text
/vantage:uninstall
```

然后 `/exit` 重新打开 Claude Code 让卸载彻底生效。

---

## 配置项

`~/.vantage/config.json`（setup 以 0600 权限生成）：

```json
{
  "name": "张三",
  "department": "外贸部",
  "server_url": "https://vantage.dgcrane.com",
  "token": "<密钥>"
}
```

**环境变量（调优）**

| 变量 | 默认 | 说明 |
|---|---|---|
| `VANTAGE_RECENT_DAYS` | 7 | 对账只回看最近 N 天 |
| `VANTAGE_SKIP_TRIGGER` | 0 | setup 时跳过 Codex 触发器（测试用） |
| `VANTAGE_SELF_UPDATE_INTERVAL_H` | 2 | 插件自更新检查间隔（小时） |
| `VANTAGE_DISABLE_SELF_UPDATE` | 空 | 置非空则关闭插件自更新 |

---

## 运维

- **看积压**：`~/.vantage/spool/` 空 = 都传上去了
- **日志**：`~/.vantage/agent.log`
- **死信**：`~/.vantage/dead/`

---

## 发版注意

每次发版务必 bump `plugin/.claude-plugin/plugin.json` 里的 `version`，否则员工端不会自动更新。

插件会在每次 `SessionStart` 时后台检查 marketplace 新版本，2 小时节流，自动更新。
