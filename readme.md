# koishi-plugin-exchange-rate

[![npm](https://img.shields.io/npm/v/koishi-plugin-exchange-rate?style=flat-square)](https://www.npmjs.com/package/koishi-plugin-exchange-rate)

为 [Koishi](https://koishi.chat/) 提供法币与加密货币兑换查询。

## 安装

在 Koishi 插件市场安装 `koishi-plugin-exchange-rate`，或在机器人项目中执行：

```sh
yarn add koishi-plugin-exchange-rate
```

插件依赖 Koishi 的 `http` 服务；请确保该服务可用。

## 使用

注册命令为：

```text
exchange <query:text>
```

`query` 为必填参数，使用以下形式，其中金额可以是 `0`：

```text
exchange 20 USD to CNY
exchange USD 20 to CNY
```

也可以直接发送同样的完整查询作为快捷方式：

```text
20 USD to CNY
￥0.5 to JP¥
1 BTC to USDT
```

快捷方式只匹配完整、有效的查询；普通聊天文本不会被拦截或重复处理。

### 货币别名

法币代码不区分大小写，也支持常用别名，包括 `$`、`US$`、`美元`、`RMB`、`CN¥`、`￥`、`¥`、`人民币`、`£`、`英镑`、`€`、`欧元`、`JP¥`、`円`、`日元`、`HK$`、`港币` 和 `港元`。其他资产代码必须是 2 到 10 位英文字母。查询不接受换行、科学计数法、负数或超出 JavaScript 安全整数范围的金额。

## 法币与加密资产

法币汇率由 Frankfurter 提供。加密资产同时查询 Binance 与 OKX 的现货买一/卖一行情，并分别显示结果。

若交易所没有直接交易对，插件可通过 USDT 与 USD 法币汇率桥接，例如 BTC/CNY、CNY/BTC 或部分加密资产交叉对。交易对目录会过滤非现货、非交易状态的市场。

加密报价的买卖价差不超过 10 个基点（10 bps）时显示中间价；价差更大时显示买价和卖价区间。法币结果和加密结果的小数精度可分别配置。

## 配置

| 配置项 | 默认值 | 说明 |
| --- | ---: | --- |
| `cacheTtl` | `3600000` | 法币汇率缓存时间（毫秒）；`0` 禁用缓存。 |
| `timeout` | `10000` | 每个 HTTP 请求的超时时间（毫秒）。 |
| `maxCacheEntries` | `256` | 法币和加密行情缓存的最大条目数。 |
| `precision` | `4` | 法币结果最多保留的小数位数。 |
| `proxy` | `''` | Binance 和 OKX 请求使用的代理地址。 |
| `cryptoCacheTtl` | `5000` | 加密行情缓存时间（毫秒）；`0` 禁用缓存。 |
| `cryptoPrecision` | `2` | 加密结果最多保留的小数位数。 |
| `catalogRefreshInterval` | `21600000` | 交易对目录刷新间隔（毫秒）；`0` 禁用定时刷新。 |

## 数据源与免责声明

法币数据来自 [Frankfurter](https://www.frankfurter.app/)。加密行情来自 [Binance](https://www.binance.com/) 和 [OKX](https://www.okx.com/)。网络、市场状态或上游服务均可能导致结果不可用或延迟。

汇率和行情仅供参考，不构成投资、交易、换汇或其他财务建议。使用者应在交易或支付前向可靠渠道核实实际价格、可用性和费用。
