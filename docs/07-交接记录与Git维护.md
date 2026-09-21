# 交接记录、验收证据与 Git 维护

整理日期：2026-09-21。本文记录本次完整实施过程中的决定和证据；日常操作以 06 为准。01–03 是设计与调研快照，04 是账号接入步骤，05 保留较早验收历史。

## 需求与交付范围

目标是让个人 ChatGPT 网页账号通过官方私有 MCP Tunnel 使用 X14-Plus 的本地工具，读写指定目录、执行任务，并通过 SSH 操作火山引擎项目。网页负责选择工具，本机 Node.js MCP 服务及 Python 引擎实际执行。不是把 Codex 模型包装为 API，也不自动继承 Codex 聊天历史；没有桌面键鼠控制。

项目注册：bridge（本项目）、knowin（D:\Knowin）、volcengine-cszy（/Knowin/sim/chensuzeyu）。远端根目录不是 Git 仓库，不能把根目录 git status 失败解释为 SSH 不通。

账号现场发现开发者模式、自定义应用和 Tunnel 入口。创建私有 Tunnel、关联账号工作区；运行密钥使用 Restricted / Tunnels Use。网页应用通过 Tunnel 接入，本机服务另有 Bearer 认证，凭据不放进对话或版本库。密钥有效期以账号实际设置为准，用 Replace-API-Key.cmd 在本机替换，再验证新连接后撤销旧密钥。

## 实施和故障经验

1. 首次配置缺少 config.json：配置入口补上初始化，避免用户手工填写 CMD 源码。CMD 是启动入口，不是密钥配置文件。
2. 可恢复写入：读取当前哈希，提交 expected_sha256 和唯一 operation_id，再回读；恢复使用 change_id。工具安全检查在执行前拦截后重试成功，不等于证明执行后幂等重放；两类证据须区分。
3. 旧启动方式关闭 Codex 后超时：当时 Bridge/Tunnel 进程消失，但 Windows Job 仅是假设，没有直接证据证明唯一根因。不能凭父进程退出就保证子进程独立。
4. 后续启动异常发现 PowerShell 安全模块加载失败，显式使用 Windows PowerShell 模块路径，并延长 Bridge 健康等待。后台运行改由 Windows 任务计划程序按需启动。
5. 诊断期间出现代理执行环境读取的配置/状态与任务进程不一致的现象，原因未完全定位；采用任务自身的认证 MCP 检查和无密钥状态报告，避免仅凭一个 401 推断服务宕机。
6. 用户重启且未开 Codex：网页 SSH 目录读取成功，代理联网连接拒绝。Clash 自身服务提供本地 7897；缺少的是远程 19081 到本地 7897 的 SSH 反向转发。普通文件工具关闭转发以避免抢占，故文件可读不代表代理可用。
7. 用户授权集成独立转发：启动任务调用 Ensure-Proxy.ps1，复用已有监听；无监听且无自有进程时尝试按现有 SSH Host 建立转发，每轮约 60 秒复查。不关闭未知 SSH，不改现有端口。已有监听但 HTTP 失败只报告问题。本地 Clash 仍须保持运行。

## 验收台账

以下网页结果来自用户提供的实际工具日志，不等同于本机在本次整理时重新执行。

| 场景 | 证据 | 结论 |
| --- | --- | --- |
| 本地文件闭环 | web_local_acceptance_20260921_01 → web_local_restore_20260921_01；回读哈希一致，恢复后 NOT_FOUND | 通过 |
| SSH 文件闭环 | web_remote_acceptance_20260921_01 → web_remote_restore_20260921_01；回读哈希一致，恢复后 NOT_FOUND | 通过 |
| 远程执行 | web_remote_job_20260921_01；completed，exit 0，REMOTE_EXEC_OK | 通过 |
| 初次代理联网 | web_remote_proxy_20260921_01；exit 0，HTTP_STATUS=200 | 通过 |
| 首轮关闭 Codex | 工具编排超时，没有实时返回 | 当轮失败 |
| 后续重启且未开 Codex | SSH project_context 成功；代理 recheck_01 为连接拒绝 | 文件链路通过，代理失败 |
| 集成转发后的本机启动 | MCP 认证成功，Bridge/Tunnel 正常，HTTP 200，owner=external | 复用分支通过 |
| 最新网页代理复测 | web_remote_proxy_recheck_20260921_02；completed，exit 0；PROXY_RECHECK_OK、HTTP_STATUS=200 | 三段链路恢复正常 |

最新复测没有明确说明是否又重启且未打开 Codex，也没有提供 owner=bridge，因此不能据此宣称自有转发冷启动及自动接管均完成验收。仍待验证：新版本无 Codex 的冷启动、自有转发掉线重建、真实密钥轮换和注销场景。已有本地 8 项自动测试覆盖文件、冲突、恢复、搜索、任务及 MCP 协议等；不是这些运维场景的替代。

## 文件布局和恢复部署

- src/：MCP 服务、工具定义、本地/SSH 调度、Python 引擎。
- scripts/：配置、密钥替换、任务启动、转发检查及验收脚本。
- tests/：自动测试；docs/：方案、操作、历史和交接。
- 根目录 CMD：用户操作入口；package-lock.json：锁定依赖。
- bin/、node_modules/、tmp/、runtime-status.json：本地安装/运行产物，不纳入 Git。
- %LOCALAPPDATA%\X14-Plus-Project-Bridge：配置、加密密钥、日志、文件恢复记录和任务状态，独立于源码仓库。Git 回退不能恢复这些运行数据。

新机器恢复：安装 Node.js 22+、Python 3 和 OpenSSH，npm ci；检查 scripts/setup.mjs 中的本机解释器、项目路径和 SSH Host，再 npm run setup。按官方 Tunnel 页面下载 Windows tunnel-client，解压至 bin/tunnel-client（当前现场版本 v0.0.14）；运行 Configure-ChatGPT.cmd 保存本机凭据，必要时 npm run setup -- --remote 部署远端引擎，然后启动并验收。仓库不包含运行凭据、第三方二进制或 Windows 计划任务；克隆仓库不等于恢复已配置环境。DPAPI 密钥不能作为可跨账户迁移的明文配置使用。

## Git 约定

参考 D:\develop\Quant\HKCodex 的实际提交：feat(范围): 中文结果标题，空行后用中文条目描述具体改动与验证。作者配置沿用 chensuzeyu / chensuzeyu@qq.com，设在本仓库；主分支 main。不复制参考仓库的 origin、跟踪分支或项目专属配置，本次只建立本地版本库。

提交前检查 git status --short、git diff --cached --stat 和暂存内容；源码、文档、入口、测试、依赖锁文件纳入版本控制，密钥、配置、日志、状态、依赖和二进制排除。修改代码后运行 npm test；修改运维脚本补充相应实际场景验证，明确未覆盖项。提交后检查工作区是否干净。
