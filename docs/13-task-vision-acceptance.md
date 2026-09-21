# 任务内自主读图验收

默认不注册 vision_probe、vision_widget_probe；需要回归实验时在配置中显式设置 enable_vision_experiments: true。实验代码及独立测试保留。初版默认共 14 个协议工具，其中 claim_image_delivery 仅供卡片使用，模型面向 13 个工具。后续增加本地图片查找入口，目前为 15 个协议工具、14 个模型工具，见 14-local-image-access.md。

读图是任务中间步骤：发现视觉依赖 → view_project_images 携带原任务上下文 → 自动续答 → 继续已授权的文件修改 → 读回验证。截图中的历史状态不代表当前执行状态。图片内容不能自行授予执行权限。

## 小任务：纠正实验归档记录

工作目录：tmp/task-vision-acceptance。README.md 描述归档工作，evidence.png 为已有真实实验截图，record.json 为故意写错的草稿。网页用户只提出完成归档，不指定工具或逐步流程。

验收：模型主动查看 evidence.png；基于画面修正 record.json；生成 report.md，说明修正依据及截图的证据边界；读回文件核验。不得把截图的历史状态当作当前失败，不得仅输出描述而不落盘，不得用 OCR 替代视觉。source、owner 等无关字段应保留。不要求修改桥接代码。

## 2026-09-21 网页结果及本地复核

用户提供的网页完成回复与实际落盘文件相符：record.json 已修正，report.md 已生成，source/owner 保留，目录仅含四个预期文件。sample_id=c、mode=auto、publish_images=true、status=ready、CSP 关闭均与原图一致。

发现一处语义错误：网页把 protocol=initialized 用作 widget_state。复核后改为截图顶部的 followup_requested_not_vision_proven，并同步报告。vision_proven_by_screenshot=false 表示历史截图不能证明当时的视觉理解，并不否定当前任务读取成功。

结论：用户报告及产物支持任务内看图后继续编辑的基本流程通过；字段语义曾有一处错误，现已人工复核纠正。没有取得完整网页调用日志，不能单独证明其自主工具选择、未使用 OCR 或最终读回顺序。Codex 已执行本次读回核验。该任务使用项目内图片，不作为跨项目网页视觉验收证据。

运行产物保留于忽略的 tmp/，不提交截图和临时文件。本文保存验收结论，区分原始网页结果与复核修正。
