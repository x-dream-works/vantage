# Vantage

> dgcrane 内部 AI 编程工具（Claude Code / Codex）用量统计插件

公司为团队统一采购了 Claude Code / Codex 的付费额度。Vantage 是这些额度的**计量表**——像水表电表一样记录各工具的用量，汇总到公司用量看板，用于额度续费与资源调配决策。

**数据仅用于团队整体的额度管理，不用于个人考核。** 代码在本仓库完全开源，可自行核验（见「如何核验」），并支持一键彻底卸载（见「卸载」）。

---

## 安装

**前置条件**：已安装 [Git for Windows](https://git-scm.com/download/win)（一路默认下一步即可）和 Claude Code。

打开 **cmd**，执行下面这一条命令（把「张三」换成你的姓名）：

```bat
(claude plugin marketplace update dgcrane 2>nul || claude plugin marketplace add https://github.com/x-dream-works/vantage.git) & claude plugin update vantage@dgcrane 2>nul & claude plugin install vantage@dgcrane 2>nul & node "%USERPROFILE%\.claude\plugins\marketplaces\dgcrane\plugin\setup.cjs" "张三"
```

- 部门按姓名自动匹配公司通讯录，无需填写
- 命令可重复执行，已安装时不会出错
- 若提示姓名不在通讯录（会同时列出相近的候选名），请核对拼写后重新执行
- 安装完成后**无需重启、无需任何日常操作**，插件自动记录用量

<details>
<summary>备选方式：在 Claude Code 内安装</summary>

```text
/plugin marketplace add https://github.com/x-dream-works/vantage.git
/plugin install vantage@dgcrane
/reload-plugins
/vantage:setup
```

按 `/vantage:setup` 提示输入姓名（部门自动匹配通讯录）。

</details>

---

## 采集内容

插件统计各工具的 **token 用量**和 **Codex/ChatGPT 的剩余额度**，连同姓名、部门汇总到公司用量看板，用于团队整体用量分析和后续 AI 额度的购买规划。

**不采集**对话内容、代码内容、文件名，以及任何行为考核类数据；账号凭据不上传。数据仅用于额度规划，**不用于个人考核**，不提供给任何第三方。

---

## 后台机制说明

为完整统计 Codex 用量（其无会话结束通知机制），插件会安装以下本机组件：

| 组件 | 作用 |
|---|---|
| Claude Code 会话钩子 | 会话开始/结束时采集本次用量 |
| Windows 每小时计划任务 | 兜底扫描 Codex 会话（错过开机自动补跑；以隐藏窗口运行，不弹黑窗） |

插件会在会话开始时自动检查并安装新版本。如不希望自动更新，可设置环境变量 `VANTAGE_DISABLE_SELF_UPDATE`。

---

## 如何核验

1. **看待上报数据**：`~/.vantage/spool/` 下每个 JSON 就是一条待上报记录，可逐字段与上表核对（上报成功即删除，历史动作见 `agent.log`）
2. **看运行日志**：`~/.vantage/agent.log` 记录每次采集与上报
3. **核对代码**：本仓库即全部运行代码，可对照本地安装目录审阅

## 常见问题

**杀毒软件报毒怎么办？**
每小时定时执行的隐藏脚本是杀毒软件启发式（360 / 火绒 / Windows Defender）的常见误报对象。**默认建议：不处理**——被误杀只会造成最长 1 小时的采集延迟，数据不丢（下次运行时自动补传）。Vantage 不会修改你的杀毒软件设置；如确需消除误报，请联系公司 IT 统一处理。

---

## 卸载

```text
/vantage:uninstall
```

然后重新打开 Claude Code 即可彻底生效。残留的本机目录 `~/.vantage/` 可手动删除。

---

安装或使用遇到问题，请联系公司管理员。
