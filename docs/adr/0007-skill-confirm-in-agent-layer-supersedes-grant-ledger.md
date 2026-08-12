# Skill 脚本授权移回 agent 确认层,废除 grant 信封与授权账本

**Supersedes ADR 0006**(授权账本归 daemon 持有)的 skill 部分。

视频解析等「本地重计算 skill」需要访问不可枚举的网络资源(视频 CDN 域名上千且动态),grant 信封的静态域名白名单在此必然失效:要么宽通配形同虚设,要么实质不可用。借此重新审视整个信封模型后,决定不是给信封加「全网档」,而是**删除信封体系本身**。

**决定**:

1. **删除 grant 信封整套**:SKILL.md `metadata.pie.*` 能力声明、`GrantEnvelope`/`envelopeHash`、`~/.pie/grants.json`、`skill_auth_required` 回话协议、TOCTOU `approvedEnvelopeHash` 重调。设置页 grant 列表/撤销 UI 一并删(audit「最近执行」保留)。
2. **授权 = agent 确认层的工具级确认**:SW 在发 `run_skill_script` 前走 panel-request 原语弹确认卡(skill 名 + description + entry + args 全文),**会话内记住**(批准记录进 session 持久状态,IDB);新会话重新确认。无持久授权层。
3. **沙箱降为固定基线、不可声明不可配**:写限 session workspace + `denyRead` 敏感目录基线 + 网络全放 + env 白名单擦除(`PATH`(login-shell 版)/`HOME`/`TMPDIR`/`LANG`/`LC_*`/`USER`/`SHELL`/`PIE_*`,其余全擦)。网络全放后 env 擦除是外泄面的主压制手段,属强制项。
4. **daemon 不再做授权判定**,收到请求即按基线沙箱执行。唯一保留的信任边界是「LLM 不能自批」——确认逻辑在 SW 层、不进 tool schema,与 panel-request 既有语义同构。

**为什么推翻 0006 的理由不再成立**:

- 0006 拒绝「daemon 无条件信任扩展」的核心论据是「daemon 沦为谁连上就执行,特权执行无自我防线」。但能连 `~/.pie/daemon.sock` 的进程本来就是同一用户权限的本地进程,它不需要绕 Pie 就能执行任意命令——daemon 侧授权校验防的是一个不存在的攻击者。真实威胁只有 prompt injection 驱动 LLM 自批,而这条在 SW 层挡住即可。
- 0006 担心「grant 随浏览器清存储蒸发」——会话内记住的批准本来就不持久,该论据失去对象。
- `permsHash 进 key、声明一变自动失效` 的精巧机制,服务的是「静态声明可信」这个前提;而不可枚举资源场景证明静态声明本身是错误抽象。用户批准的真实心智是「我信任这个 skill 做它说的事」,权限清单制造的是虚假知情同意。

**下游影响**:wire 语义破坏(`run_skill_script` 参数变更、`skill_auth_required` 删除)→ `PROTOCOL_VERSION` 1→2,扩展抬 `MIN_DAEMON_VERSION`,与长任务执行模型改造(删超时/runId/poll/kill)合并为同一次 daemon breaking 发版。`grants.json` 遗留文件不迁移不清理。MCP 类 grant(0006 亦覆盖)当前未实现,未来若做,默认同此模型(会话内确认),除非出现真实的持久化需求。

设计全文:`docs/specs/2026-08-12-skill-longrun-exec-and-confirm-model.md`。
