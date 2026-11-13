# 来源协议

事项 move-17。profile.version 每次地址修改递增。consents 中的正整数是授权版本，null 表示撤回。POST /department/:部门/receive 需传 caseId、profileVersion、consentVersion、fields、dispatchId；同 dispatchId 重传返回原回执，不同内容返回409。受理回执冻结当时字段。housing 缺 paymentProof 返回422。POST /control 支持 address、revoke、restore、lateResponse。受理结果可按 /receipts 查询。页面有三个部门页签和资料修订控件。

## 通用控制

`GET /inventory` 返回本来源当前目录，`GET /health` 检查存活，`GET /state` 查看来源状态。`POST /control` 接收JSON对象，仅在来源支持的字段范围内操作。每次创建服务重新读取 fixtures/source.json；控制用于复现来源演进，不是采集业务的实现接口。

服务使用随机本地端口，测试启动与关闭均由代码负责。没有真实个人资料、凭据或付费调用。
