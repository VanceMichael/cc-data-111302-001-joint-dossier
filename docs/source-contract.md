# 来源协议

事项 move-17。profile.version 每次地址修改递增。consents 中的正整数是授权版本，null 表示撤回。requirements 中每项可为字符串或 `{name,label,kind}`，`kind` 为 `field` 或 `file`；页面按部门渲染对应输入框并标出文件类要求。POST /department/:部门/receive 需传 caseId、profileVersion、consentVersion、fields、dispatchId；同 dispatchId 重传同内容返回原回执，不同内容返回409。受理回执冻结当时字段。缺必填返回422。POST /control 支持 address、name、revoke、restore、block、unblock、lateResponse、failureMode。受理结果可按 /receipts 查询。页面有三个部门页签、资料修订控件和医保授权撤回控件。

## 通用控制

`GET /inventory` 返回本来源当前目录，`GET /health` 检查存活，`GET /state` 查看来源状态，`GET /receipts` 查看已受理回执。`POST /control` 接收 JSON 对象，仅在来源支持的字段范围内操作：

- `address`：修订迁入地址并递增 `profile.version`；
- `revoke` / `restore`：将某部门授权设为撤回 / 恢复为下一版本；
- `block` / `unblock`：临时拒收某部门（503），用于复现可恢复的不可用；
- `lateResponse`：受理后直接断开连接（仅便于观察网络中断，Chromium 会自动重试，故测试不依赖它）；
- `failureMode: "truncate"`：受理后持续返回截断的响应体，用于复现“来源已记回执但窗口拿不到响应”。

控制用于复现来源演进，不是采集业务的实现接口。每次创建服务重新读取 fixtures/source.json。

## 一致性边界

- 来源只负责单部门受理与回执冻结，不替调用方判断共用材料是否一致。
- 同一 `dispatchId` 的重传是幂等的；不同内容复用同一身份返回409。
- 是否向已受理分支再次送出、是否把更正转成登记需求，属于助手职责，来源不做审批判断。

服务使用随机本地端口，测试启动与关闭均由代码负责。没有真实个人资料、凭据或付费调用。
