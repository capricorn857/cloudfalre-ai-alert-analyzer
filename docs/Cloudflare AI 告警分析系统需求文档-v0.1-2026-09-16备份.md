# Cloudflare AI 告警分析系统需求文档

## 1. 文档信息

| 项目 | 内容 |
|---|---|
| 项目名称 | Cloudflare AI Alert Analyzer |
| 中文名称 | Cloudflare AI 告警分析系统 |
| 文档类型 | 产品/业务需求文档 |
| 当前阶段 | MVP |
| 当前版本 | v0.1 |
| 首期范围 | Cloudflare WAF 安全告警 |
| 目标用户 | 运维、安全人员 |
| 通知渠道 | 企业微信 |
| 系统定位 | 告警分析与辅助决策，首期只读 |

---

# 2. 项目背景

当前业务使用 Cloudflare 提供 CDN、WAF 等安全能力。

当 Cloudflare 检测到 WAF / Security Events 异常时，可以产生类似以下告警：

```json
{
  "name": "cloudflare-alert",
  "data": {
    "account_name": "example-account",
    "actions": "allow",
    "alert_start_time": "2026-09-14T09:18:46Z",
    "events_count": "394",
    "zone_name": "example.com",
    "zone_tag": "xxxxxxxxxxxxxxxx"
  },
  "alert_type": "clickhouse_alert_fw_anomaly",
  "alert_event": "ALERT_STATE_EVENT_START",
  "alert_correlation_id": "2099428449234980864"
}
```

现有告警主要提供：

- 告警域名
- 告警时间
- Security Events 数量
- Cloudflare Dashboard 地址
- 基础告警类型

这些信息只能说明“发生了异常”，无法直接回答：

- 谁在攻击？
- 攻击来自哪些国家或地区？
- 攻击集中在哪些 ASN？
- 主要攻击哪些 URL？
- 是否集中攻击登录、注册等关键 API？
- Cloudflare 是否已经进行 Block / Challenge？
- 是否存在大量攻击请求仍被 Allow？
- 可能属于扫描、暴力破解、Bot 还是 API Abuse？
- 当前风险程度如何？
- 运维人员下一步应该做什么？

因此，当前告警发生后仍需要运维或安全人员进入 Cloudflare Dashboard 手工分析 Security Analytics 数据。

本项目希望通过 Cloudflare API、规则分析和大语言模型，将传统的“告警通知”升级为“AI 安全事件分析”。

---

# 3. 项目目标

## 3.1 核心目标

当 Cloudflare WAF 产生安全告警后，系统能够自动完成：

```text
Cloudflare Alert
        ↓
获取告警上下文
        ↓
查询 Security Analytics
        ↓
安全事件数据统计
        ↓
规则分析
        ↓
AI 安全分析
        ↓
生成结构化报告
        ↓
企业微信通知
```

运维人员收到企业微信告警后，应能够快速回答五个核心问题：

### 谁在攻击？

包括：

- Source IP
- Country / Region
- ASN

### 攻击什么？

包括：

- Host
- Request Path
- 重点 API

### 攻击规模多大？

包括：

- Security Events 数量
- Top IP 占比
- Top Path 占比
- Country / ASN 集中度

### Cloudflare 做了什么？

包括：

- Allow
- Block
- Challenge
- 其他 Action

### 下一步怎么办？

包括：

- 风险等级
- 可能攻击类型
- 分析证据
- 处置建议

---

# 4. 非目标

MVP 不建设完整的 SOC、安全运营平台或告警管理平台。

首期明确不实现：

- Web 管理后台
- 用户权限管理系统
- 历史告警检索
- Dashboard
- 自动封禁攻击 IP
- 自动修改 WAF Rule
- 自动修改 Rate Limit
- 自动修改 Cloudflare 配置
- 自动执行生产变更
- 多云安全告警统一管理
- RAG
- MCP
- OpenClaw Agent 集成
- 复杂工作流审批

首期系统定位为：

> **Read Only + Analysis + Notification**

即：

```text
读取数据
   ↓
分析数据
   ↓
生成建议
   ↓
发送通知
```

不自动修改生产环境。

---

# 5. 用户角色

MVP 主要包含以下用户角色。

## 5.1 运维人员

主要需求：

- 快速知道发生了什么
- 判断是否影响业务
- 判断是否需要立即处理
- 根据分析建议执行后续排查

## 5.2 安全人员

主要需求：

- 获取攻击来源
- 获取攻击目标
- 获取攻击行为特征
- 判断攻击类型
- 判断 Cloudflare 防护效果
- 获取进一步安全处置建议

MVP 不需要在系统内部实现角色和权限控制。

---

# 6. 使用场景

## 6.1 WAF Security Events 异常

Cloudflare 检测：

```text
example.com
Security Events 短时间突然增加
```

产生告警：

```text
Events: 394
Action: allow
```

系统自动查询相关 Security Analytics 数据。

最终发现：

```text
Top IP:
1.2.3.4
218 requests
55.3%

Top Country:
US
250 requests
63.5%

Top Path:
/api/login
180 requests
45.7%

Action:
Allow 88.8%
Block 11.2%
```

系统进一步分析：

```text
攻击流量高度集中于单一 IP。

主要目标为 /api/login。

结合 IP、请求路径和 Security Events 行为，
可能存在 API 暴力尝试。

当前大量相关请求仍被 Allow。
```

并通过企业微信通知运维人员。

---

# 7. 系统整体流程

```text
Cloudflare
     │
     │ Alert
     ▼
Webhook Receiver
     │
     ▼
Alert Parser
     │
     ▼
Alert Dispatcher
     │
     ▼
WAF Analyzer
     │
     ▼
Cloudflare Security Analytics
     │
     ▼
Data Normalizer
     │
     ▼
Unified Incident
     │
     ▼
Statistics Analyzer
     │
     ▼
Rule Analyzer
     │
     ▼
AI Analyzer
     │
     ▼
Message Formatter
     │
     ▼
企业微信
```

---

# 8. 功能需求

## FR-001 Cloudflare 告警接收

### 描述

系统需要提供 HTTP API，用于接收 Cloudflare 告警 Payload。

建议接口：

```text
POST /api/v1/alerts/cloudflare
```

### 输入

至少支持：

```text
zone_name
zone_tag
alert_start_time
events_count
alert_type
alert_event
alert_correlation_id
dashboard_link
```

### 要求

系统收到告警后需要：

1. 校验 Payload
2. 判断告警类型
3. 生成内部 Alert 对象
4. 创建后台分析任务
5. 尽快向调用方返回成功响应

### 异常处理

以下情况不得进入后续 AI 分析：

- Payload 无法解析
- 缺少 zone_tag
- 缺少 alert_start_time
- 不支持的 alert_type

系统需要记录错误日志。

---

# 9. FR-002 告警类型识别

系统需要根据：

```text
alert_type
```

识别告警类型。

MVP 支持：

```text
clickhouse_alert_fw_anomaly
        ↓
waf_attack
```

系统内部不应将整个处理流程直接绑定到 WAF。

需要预留：

```text
Alert
  ↓
Dispatcher
  ↓
Analyzer
```

机制。

未来允许增加：

```text
WAF Analyzer
DDoS Analyzer
Origin Analyzer
Traffic Analyzer
SSL Analyzer
```

增加新 Analyzer 时，不应要求修改 AI、通知等核心模块。

---

# 10. FR-003 分析时间窗口计算

系统需要根据：

```text
alert_start_time

query_started_at
```

自动计算 Security Analytics 查询窗口。

MVP 采用一次性快照分析，默认：

```text
start = alert_time - 30 minutes

end = query_started_at
```

其中：

- `alert_time` 为 Cloudflare 告警中的 `alert_start_time`
- `query_started_at` 为后台任务实际开始查询 Cloudflare 数据的时间
- 后台任务开始后新增的 Security Events 不纳入本次分析
- MVP 不等待未来时间窗口，不因数据持续增长执行二次分析

为缓冲 Cloudflare 数据写入或聚合延迟，后台任务可在收到告警后等待固定时间再开始查询。

MVP 默认：

```text
settle_seconds = 60
```

该缓冲时间用于改善首次快照的数据可用性，不用于判断数据是否收敛。

例如：

```text
Alert:

2026-09-14T09:18:46Z

Query Started At:

2026-09-14T09:20:00Z
```

查询：

```text
2026-09-14T08:48:46Z
        ↓
2026-09-14T09:20:00Z
```

`before_minutes` 和 `settle_seconds` 需要支持配置化。

该窗口表示系统进行首次研判时已经发生的数据快照，不代表攻击事件的完整生命周期。

---

# 11. FR-004 Cloudflare Security Analytics 查询

系统根据：

```text
zone_tag
analysis_window
```

调用 Cloudflare GraphQL API。

MVP 对每个有效告警只执行一轮固定窗口的数据采集。同一轮可按数据维度发起一个或多个 GraphQL 请求。仅在请求超时、限流或服务端临时错误等技术故障时进行有限重试，不因查询结果发生变化而启动新一轮采集或重新分析。

告警 Payload 中的 `events_count` 作为 Cloudflare 告警参考值保留。统计比例统一使用本次 GraphQL 查询得到的 `total_events` 作为分母。两者可能因时间窗口、采样或数据聚合口径不同而存在差异，不要求强制相等。

MVP 至少获取以下数据。

## Top IP

返回：

```text
IP
Count
```

## Top Path

返回：

```text
Request Path
Count
```

## Top Host

返回：

```text
HTTP Host
Count
```

## Top Country

返回：

```text
Country
Count
```

## Top ASN

返回：

```text
ASN
Count
```

## Action

至少识别：

```text
allow
block
challenge
managed_challenge
其他 Cloudflare Action
```

## Source

获取 Cloudflare Security Event Source。

## Samples

MVP 默认最多获取：

```text
50
```

条安全事件样本。

样本至少包含：

```text
datetime
action
clientIP
clientCountryName
clientAsn
clientRequestHTTPHost
clientRequestPath
source
userAgent
```

---

# 12. FR-005 数据标准化

Cloudflare GraphQL Raw Response 不允许直接传给 LLM。

系统需要转换为内部统一：

```text
Incident
```

数据模型。

示例：

```json
{
  "incident_id": "2099428449234980864",
  "provider": "cloudflare",
  "alert_type": "waf_attack",
  "resource": "example.com",

  "alert_time": "2026-09-14T09:18:46Z",

  "analysis_window": {
    "start": "2026-09-14T08:48:46Z",
    "end": "2026-09-14T09:28:46Z"
  },

  "metrics": {},

  "evidence": {
    "top_ips": [],
    "top_paths": [],
    "top_hosts": [],
    "top_countries": [],
    "top_asns": [],
    "actions": [],
    "sources": []
  },

  "samples": []
}
```

该模型需要能够支持未来其他 Cloudflare 告警类型。

---

# 13. FR-006 统计分析

所有确定性统计由程序完成，不交给 LLM 计算。

系统至少需要计算：

## Security Events

```text
total_events
```

## IP Concentration

例如：

```text
218 / 394 × 100 = 55.3%
```

## Path Concentration

例如：

```text
180 / 394 × 100 = 45.7%
```

## Country Concentration

计算 Top Country 占比。

## ASN Concentration

计算 Top ASN 占比。

## Action Ratio

至少计算：

```text
allow_ratio
block_ratio
challenge_ratio
```

例如：

```text
Allow = 350
Total = 394

Allow Ratio = 88.8%
```

---

# 14. FR-007 规则分析

AI 分析之前必须执行规则分析。

规则分析负责产生确定性 Finding。

例如：

```json
{
  "type": "ip_concentration",
  "level": "high",
  "value": 55.3
}
```

MVP 至少实现：

| Rule | 描述 |
|---|---|
| IP Concentration | 攻击是否集中于少量 IP |
| Path Concentration | 是否集中攻击某个 URL |
| Country Concentration | 是否集中来源于某国家 |
| ASN Concentration | 是否集中来源于某 ASN |
| Allow Ratio | Security Events 被 Allow 的比例 |
| Block Ratio | 被 Block 的比例 |
| User-Agent Concentration | UA 是否高度集中 |
| Request Rate | 请求事件速率 |

规则阈值不得硬编码在业务代码中。

建议支持配置：

```yaml
rules:

  ip_concentration:
    medium: 30
    high: 50

  path_concentration:
    medium: 30
    high: 50

  allow_ratio:
    medium: 50
    high: 80
```

---

# 15. FR-008 AI 安全分析

系统将：

```text
Incident
+
Statistics
+
Findings
```

提交给 LLM。

LLM 不负责重新查询 Cloudflare。

LLM 不负责重新计算统计数据。

AI 主要负责：

### 风险判断

输出：

```text
LOW
MEDIUM
HIGH
CRITICAL
```

### 攻击行为判断

MVP 支持：

```text
Scanning
Brute Force
Credential Stuffing
API Abuse
Bot
Vulnerability Scanning
Unknown
```

攻击类型必须基于 Evidence。

无法判断时返回：

```text
Unknown
```

并明确：

```text
证据不足
```

### 事件总结

使用简洁语言描述：

```text
发生了什么
主要攻击来源
主要攻击目标
Cloudflare 防护情况
```

### Evidence

AI 判断需要提供依据。

例如：

```text
Top IP 占事件总量 55.3%

/api/login 占事件总量 45.7%

88.8% Security Events 被 Allow
```

### Recommendations

最多提供：

```text
3 条
```

处置建议。

---

# 16. FR-009 AI 输出约束

LLM 必须返回结构化结果。

建议格式：

```json
{
  "risk_level": "HIGH",

  "attack_type": "Possible API brute force",

  "confidence": 0.82,

  "summary": "攻击流量高度集中于登录接口。",

  "evidence": [
    "Top IP 占全部事件 55.3%",
    "/api/login 占全部事件 45.7%",
    "88.8% 相关事件被 Allow"
  ],

  "recommendations": [
    "确认主要来源 IP 是否属于正常业务",
    "检查 /api/login 是否需要 Rate Limit",
    "检查相关 WAF Rule"
  ]
}
```

AI 必须遵守：

1. 不编造不存在的数据
2. 不修改程序计算结果
3. 区分事实和推测
4. 数据不足时明确说明
5. 不直接执行安全变更
6. 不生成超过输入 Evidence 能够支持的确定性结论

---

# 17. FR-010 企业微信通知

分析完成后，系统需要通过企业微信机器人发送告警分析。

通知至少包含：

```text
域名
告警时间
事件数量
风险等级
Top IP
Top Country
Top ASN
Top Path
Cloudflare Action
AI Summary
Evidence
Recommendations
Cloudflare Dashboard
```

示例：

```text
【Cloudflare WAF 安全告警】

域名：
example.com

告警时间：
2026-09-14 17:18:46 GMT+8

安全事件：
394

风险等级：
HIGH

────────────

攻击来源

Top IP

1. 1.2.3.4  218 (55.3%)
2. 5.6.7.8   76 (19.3%)

Top Country

US  250 (63.5%)
SG   70 (17.8%)

────────────

攻击目标

/api/login     180 (45.7%)
/api/register   90 (22.8%)

────────────

Cloudflare Action

Allow  350 (88.8%)
Block   44 (11.2%)

────────────

AI 分析

攻击流量高度集中于单一 IP，
并主要针对 /api/login。

根据现有证据，疑似存在 API 暴力尝试。

当前大量相关事件仍被 Allow。

────────────

建议

1. 确认主要来源 IP 是否属于正常业务
2. 检查 /api/login 是否需要 Rate Limit
3. 检查对应 WAF Rule

Cloudflare Dashboard：
查看 Security Analytics
```

---

# 18. FR-011 消息格式控制

企业微信通知不能直接发送 LLM 原始输出。

必须经过：

```text
AI Result
+
Incident
+
Statistics
        ↓
Message Formatter
        ↓
WeCom
```

目的：

- 保证告警格式统一
- 防止 AI 输出格式变化
- 保证关键数据一定展示
- 控制消息长度
- 将事实数据和 AI 结论分开

---

# 19. FR-012 后台任务

Webhook 接口不应等待完整 AI 分析完成后才返回。

流程：

```text
POST Alert
     │
     ├── Payload Validation
     │
     ├── Create Background Task
     │
     └── HTTP Response
              │
              ▼
       Wait settle_seconds
              │
              ▼
     Fix Snapshot Window End
              │
              ▼
         Alert Analysis
```

MVP 可以使用应用内部后台任务。

MVP 暂不要求引入独立 MQ。

每个有效告警只生成一次快照分析和一次通知。MVP 不包含：

```text
数据收敛轮询
定时二次查询
持续事件跟踪
初报 / 终报机制
```

---

# 20. FR-013 日志

系统需要记录关键处理日志。

至少包含：

```text
incident_id
alert_type
zone_name
alert_time
analysis_window
query_started_at
Cloudflare API status
AI API status
WeCom status
processing duration
error
```

日志不得直接打印：

```text
Cloudflare API Token
LLM API Key
WeCom Webhook Secret
其他 Credential
```

---

# 21. FR-014 异常处理

系统需要考虑以下异常：

### Cloudflare API 调用失败

记录：

```text
incident_id
API status
error
```

不得基于缺失数据让 AI 编造分析结果。

对于超时、限流、`5xx` 等临时技术故障，可以进行 1～2 次有限重试，并使用短暂退避。重试必须复用第一次确定的 `analysis_window`，不得扩大时间窗口。

如果有限重试后仍然失败，应记录失败并发送不包含虚构分析结果的基础异常通知。

### Cloudflare 返回空数据

企业微信可明确提示：

```text
告警已接收，但当前分析时间窗口未查询到足够的 Security Events 数据。
```

空数据或事件数量较少时，不因等待更多数据而重新查询。

### LLM 调用失败

不能导致整个告警丢失。

应至少发送基础分析：

```text
Cloudflare Alert
+
Statistics
+
Rules Findings
```

并标记：

```text
AI 分析暂不可用
```

### 企业微信发送失败

记录发送失败日志，并允许进行 1～2 次有限重试。通知重试不得触发 Cloudflare 数据重新查询或 AI 重新分析。

---

# 22. 非功能需求

## NFR-001 可扩展性

新增 Cloudflare 告警类型时，应优先通过：

```text
新增 Analyzer
```

实现。

例如：

```text
analyzers/
├── waf.py
├── ddos.py
├── origin.py
└── traffic.py
```

不应复制完整 Pipeline。

---

## NFR-002 可维护性

模块需要保持职责清晰：

```text
API              接收请求
Dispatcher       分发告警
Analyzer         告警类型分析
Cloudflare       API 调用
Normalizer       数据标准化
Statistics       数据统计
Rules            确定性规则
AI               LLM 分析
Notification     企业微信
```

---

## NFR-003 安全性

所有 Credential 必须通过环境变量或 Secret 管理。

禁止写入：

```text
Git
代码
README
日志
测试数据
```

包括：

```text
Cloudflare Token
LLM API Key
WeCom Webhook
```

---

## NFR-004 AI 可追溯性

AI 输出的重要结论必须尽量能够映射到 Evidence。

例如：

```text
结论：
攻击高度集中于一个 IP

Evidence：
1.2.3.4 = 218 / 394 = 55.3%
```

避免：

```text
AI：
这是一次严重的分布式攻击
```

但输入中没有支持“分布式”的数据。

---

## NFR-005 降级能力

系统不应将 LLM 作为告警链路的唯一依赖。

理想降级关系：

```text
Cloudflare Data
       ↓
Statistics
       ↓
Rules
       ↓
      LLM
```

如果 LLM 不可用：

```text
Cloudflare Data
       ↓
Statistics
       ↓
Rules
       ↓
WeCom
```

仍然能够提供基础安全告警。

---

# 23. 数据模型

## Alert

```text
alert_id
provider
alert_type
alert_event
alert_time
resource
correlation_id
raw_payload
```

## Incident

```text
incident_id
provider
alert_type
resource
alert_time
analysis_window
query_started_at
metrics
evidence
samples
findings
```

## AIAnalysis

```text
risk_level
attack_type
confidence
summary
evidence
recommendations
```

---

# 24. MVP 数据流

```text
Cloudflare Alert Payload
          │
          ▼
     Alert Model
          │
          ▼
       Dispatcher
          │
          ▼
      WAF Analyzer
          │
          ▼
  Wait settle_seconds
          │
          ▼
 Fix Snapshot Window End
          │
          ▼
Cloudflare GraphQL Response
          │
          ▼
       Normalizer
          │
          ▼
        Incident
          │
          ▼
      Statistics
          │
          ▼
       Findings
          │
          ▼
      AI Analysis
          │
          ▼
     WeCom Message
```

---

# 25. MVP 技术约束

首期建议技术栈：

```text
Python 3.12
FastAPI
Pydantic
httpx
Uvicorn
PyYAML
Docker
```

外部依赖：

```text
Cloudflare GraphQL API
LLM API
WeCom Webhook
```

MVP 不要求：

```text
PostgreSQL
MySQL
Redis
Celery
Kafka
Kubernetes
```

---

# 26. 配置需求

系统至少需要支持：

```text
CLOUDFLARE_API_TOKEN

LLM_BASE_URL
LLM_API_KEY
LLM_MODEL

WECOM_WEBHOOK_URL
```

业务参数建议配置化：

```yaml
analysis:
  waf:
    before_minutes: 30
    settle_seconds: 60
    sample_limit: 50

rules:
  ip_concentration:
    medium: 30
    high: 50

  path_concentration:
    medium: 30
    high: 50

  allow_ratio:
    medium: 50
    high: 80
```

---

# 27. MVP 验收标准

## AC-001 告警接收

给系统发送真实或模拟 Cloudflare WAF Payload：

```text
POST /api/v1/alerts/cloudflare
```

系统能够成功解析并创建分析任务。

---

## AC-002 Security Analytics

系统能够根据：

```text
zone_tag
+
alert_start_time
+
query_started_at
```

自动查询以下一次性快照窗口的数据：

```text
[alert_start_time - before_minutes, query_started_at]
```

查询开始后新增的数据不纳入本次分析，系统不因数据持续增长执行二次查询。

---

## AC-003 数据统计

Cloudflare Dashboard 与系统展示的核心统计数据应保持一致或能够解释差异。

核验时必须使用与系统相同的分析窗口。告警 Payload 中的 `events_count` 与 GraphQL 的 `total_events` 不要求强制相等，但系统需要保留两者并能够说明统计口径。

至少验证：

```text
Top IP
Top Path
Top Country
Top ASN
Action
```

---

## AC-004 AI 准确性

AI 不得出现明显不存在的：

```text
IP
Path
Country
ASN
Count
Action
```

---

## AC-005 风险分析

系统能够输出：

```text
Risk Level
Attack Type
Confidence
Summary
Evidence
Recommendations
```

---

## AC-006 企业微信

真实告警发生后，企业微信能够收到本次固定窗口的完整快照分析结果，并展示分析窗口和数据截至时间。

---

## AC-007 AI 降级

人为模拟 LLM API 不可用。

系统仍能够发送：

```text
告警信息
统计数据
规则分析
```

并明确说明 AI 分析不可用。

---

## AC-008 安全

Git Repository、应用日志、异常信息中不得出现明文 Credential。

---

# 28. MVP 成功指标

第一阶段重点衡量以下指标。

### 告警分析成功率

目标：

```text
≥ 95%
```

定义：

```text
成功完成分析并发送企微
/
有效 Cloudflare WAF 告警
```

### 数据准确率

关键统计：

```text
Top IP
Top Path
Country
ASN
Action
```

使用相同分析窗口核验时，需要与 Cloudflare Security Analytics 基本一致或能够解释差异。

### AI 事实错误

AI 不允许编造不存在的关键攻击数据。

### 告警时效

目标：

```text
Cloudflare Alert
        ↓
AI 分析
        ↓
WeCom

3～5 分钟
```

首期优先保证快照统计口径清晰和分析准确性，不追求覆盖攻击事件的完整生命周期。

### 人工分析价值

运维人员收到告警后，应能够在不立即打开 Cloudflare Dashboard 的情况下完成初步风险判断。

---

# 29. 开发优先级

## P0：基础链路

```text
项目初始化
↓
FastAPI
↓
Webhook
↓
Payload Model
```

## P1：Cloudflare 数据

```text
Alert Parser
↓
Analysis Window
↓
GraphQL Client
↓
WAF Analyzer
```

## P2：分析能力

```text
Normalizer
↓
Incident
↓
Statistics
↓
Rules
```

## P3：AI

```text
Prompt
↓
Structured Output
↓
AI Analyzer
↓
Fallback
```

## P4：通知

```text
WeCom Formatter
↓
WeCom Webhook
```

## P5：工程化

```text
Logging
↓
Exception Handling
↓
Tests
↓
Docker
↓
部署验证
```

---

# 30. 后续规划

## Phase 2：历史数据

引入 PostgreSQL。

支持：

```text
历史 Incident
历史 AI Analysis
攻击 IP 历史
域名安全趋势
攻击类型趋势
```

---

## Phase 3：任务系统

当出现：

```text
大量告警
延迟分析
Retry
二次分析
持续跟踪
```

引入：

```text
Redis
Celery
```

或者其他可靠任务队列。

---

## Phase 4：Cloudflare 多告警类型

支持：

```text
WAF
DDoS
Origin
HTTP Error
Traffic
SSL/TLS
```

形成：

```text
                 Dispatcher
                      │
        ┌─────────────┼─────────────┐
        ▼             ▼             ▼
       WAF           DDoS         Origin
        │             │             │
        └─────────────┼─────────────┘
                      ▼
               Unified Incident
                      ▼
                  Rules + AI
```

---

## Phase 5：Baseline

增加历史基线：

```text
过去 24h
    │
    │ Compare
    ▼
Incident Window
```

识别：

```text
请求量异常增长
新 IP
新国家
新 ASN
新 Path
异常 User-Agent
异常 Action
```

使系统从：

```text
发生了什么？
```

升级为：

```text
与正常状态相比，这次事件异常在哪里？
```

---

## Phase 6：Incident Tracking

该阶段不属于 MVP。MVP 只生成一次快照分析，不包含初报、终报或持续更新。

针对同一 `correlation_id` 持续分析：

```text
09:18 Alert
  │
09:21 Initial Analysis
  │
09:30 Follow-up
  │
09:45 Status Update
```

判断：

```text
攻击是否持续
事件数量是否增长
攻击源是否变化
攻击路径是否变化
Block Ratio 是否变化
风险等级是否变化
```

---

## Phase 7：辅助处置

未来可以进一步输出：

```text
建议封禁 IP
建议 Rate Limit
建议 Managed Challenge
建议调整 WAF Rule
```

但自动执行生产变更不属于当前 MVP。

如果未来增加自动处置，默认采用：

```text
AI Analysis
      ↓
Recommendation
      ↓
Human Approval
      ↓
Execution
```

---

# 31. 最终产品方向

项目长期目标不是：

```text
Cloudflare Alert
        ↓
LLM
        ↓
企业微信
```

而是建立：

```text
Alert
  ↓
Context Collection
  ↓
Evidence
  ↓
Statistics
  ↓
Rules
  ↓
AI Analysis
  ↓
Incident Tracking
  ↓
Recommendation
  ↓
Human Decision
```

最终将 Cloudflare 的传统安全告警升级为：

> **具备上下文采集、攻击证据分析、风险判断、AI 解释和处置建议能力的智能安全告警分析系统。**

---

# 32. MVP Definition of Done

当以下完整链路稳定运行后，MVP 视为完成：

```text
真实 Cloudflare WAF Alert
            ↓
自动接收 Payload
            ↓
识别 WAF Alert
            ↓
自动计算分析窗口
            ↓
等待固定数据缓冲时间
            ↓
确定一次性快照截止时间
            ↓
查询 Cloudflare GraphQL
            ↓
生成 Unified Incident
            ↓
完成 Statistics
            ↓
完成 Rules Analysis
            ↓
完成 AI Analysis
            ↓
生成标准企微消息
            ↓
发送企业微信
```

同时满足：

- 核心统计数据准确
- AI 不编造关键事实
- AI 不可用时可以降级
- 不自动修改 Cloudflare
- Credential 不进入代码和日志
- 单次真实告警能够端到端完成分析
- 每个告警只进行一次业务数据快照分析，不持续跟踪后续新增事件

满足以上条件后，再进入数据库、异步队列、多告警类型和 Incident Tracking 等后续阶段。
