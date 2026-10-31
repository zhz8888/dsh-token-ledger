# 配置

[English](CONFIGURATION.md) | 中文

[← 返回 README](../README.zh.md)

## 配置

按 `id` 覆盖组合条目：

```yaml
- id: token-ledger
  config:
    ledgerPath: 'D:/dsh/ledger.json'   # 默认 <DSH_HOME>/token-ledger/ledger.json
    backfill: false                     # 默认 true——启动时折叠已存历史
    backfillLogs: false                 # 默认 true——同时读取磁盘上的会话日志
    rates: false                        # 默认 true——false 时完全不发网络请求
    # rates 也可以写成对象：
    # rates:
    #   source: modelsdev                # 默认按厂商数据集；改成 openrouter 则用网关报价
    #   refreshIntervalMs: 1800000       # 默认 30 分钟
    #   perVendor: 3                     # 默认每厂商取最新 3 个
    #   vendors: 15                      # 默认最多列几家厂商；填 0 则列出全部
    #   modelsUrl: 'https://…'           # 默认随 source——https://models.dev/api.json
    #   fxUrl: 'https://…/latest/USD'    # 默认 open.er-api.com
    # 月度套餐，供账单页的「按套餐」分组使用。每个套餐按账单覆盖的天数摊分，
    # 因此不满一个月就只计一部分。
    subscriptions:
      - vendor: deepseek                 # 这个套餐覆盖哪家厂商的用量
        plan: 'DeepSeek 包月'            # 账单上显示的套餐名
        amount: 199                      # 每月费用
        currency: CNY                    # 该费用的币种
        startedAt: '2026-09-01'          # 可选：这天之前不计
        endedAt: null                    # 可选：这天之后不计
        note: null                       # 可选：备注，随套餐一起显示
    # 页面如何缩短「会话」列表。导出从不缩短，所以这三项只影响页面上显示什么。
    # bill:
    #   foldSmallSessions: true          # 默认 true；设为 false 则页面上也列出每一个会话
    #   smallSessionCost: 1              # 默认 1，按账单当前币种
    #   smallSessionCalls: 10            # 默认 10
```

`rates: false` 会彻底关掉定价功能的联网，只保留手动填写的值——这正是严格离线环境
需要的配置。费率页本身照常可用。

### 数据库连接

数据库备份**不是**一个配置项。连接里有密码，而配置项会被持久化、每次防抖都会重写、
并且明文躺在 `settings.yaml` 里——密码不该出现在这三者中的任何一个。所以连接单独放在一个
文件里，与账本放在一起：

```
<DSH_HOME>/token-ledger/databases.json
```

该文件以只有属主可读的权限（`0600`）写入，所在目录是 `0700`。它由页面维护，所以密码不用
手写进 JSON，也就不会留在 shell 历史里。每条连接的形状：

```json
{
  "connections": [
    {
      "id": "gitea",
      "name": "Gitea",
      "type": "mariadb",
      "host": "127.0.0.1",
      "port": 3306,
      "database": "gitea",
      "user": "gitea",
      "password": "…",
      "dumpPath": ""
    }
  ]
}
```

`type` 取 `mysql`、`mariadb` 或 `postgres`；`port` 省略时用该引擎的默认端口；`dumpPath` 是
该引擎导出工具的路径，留空表示用 `PATH` 上的那个。这个文件只有宿主读——浏览器半边永远
看不到密码，连接在返回给页面前也会先抹掉密码。

### 历史从哪里来

全新安装看到的是**你已有的账**，而不是从今天开始记。启动时会折叠两个来源，每个会话从被谁
先折叠那一刻起就**永久归谁所有**。

- **磁盘上的会话日志**：`<DSH_HOME>/sessions/<项目>/<会话>/session.jsonl.zstd`。这是持久记录，
  内容是完整的，而且**完全不需要宿主**——`rebuild` 与 `audit` 读的就是同一批文件。凡是还没有
  被折叠过的会话都从这里来，这正是全新安装能立刻显示历史、而不是一张空表的原因。
- **`sessionPersistence`**，宿主服务。它覆盖日志覆盖不到的部分——日志文件尚未落盘的会话——
  也是实时事件流折叠过的那些会话的增量通道。

两者交出来的**不是同一个数组**：日志是宿主的 compact row 形式，下标含义与逻辑事件列表不同。
因此一条游标只会被"设置它的那个来源"推进，另一个来源会拒绝而不是重复计数。`backfillLogs:
false` 关闭启动时的磁盘折叠；`backfill: false` 则两个都关，账本从空开始。

磁盘折叠每轮事件循环只读一个会话，所以首次运行也不会卡住宿主；每一轮之后**只用一个 `stat`**
跳过自上次以来没被写过的日志。已经跑过的主机在历史上不花任何代价——只有首次运行、或者某个
会话在本宿主之外被续跑过之后，才会真正打开文件。


---

## 更多文档

- [这些数字是怎么数出来的](COUNTING.zh.md) —— 计数规则、fork 与 resume、以及审计
- [设置页](SETTINGS-PAGE.zh.md) —— 四个页签的完整说明
- [配置](CONFIGURATION.zh.md) —— 插件会读到的每一个配置项
- [兼容性](COMPATIBILITY.zh.md) —— 需要哪个 DSH，以及它会碰什么
- [开发与发布](DEVELOPMENT.zh.md) —— 怎么改这个插件，以及怎么发布它
- [验证记录](VERIFICATION.zh.md) —— 实际验证了什么，以及哪些没有验证
- [全部文档](README.zh.md) —— 索引
