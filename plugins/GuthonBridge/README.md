# Guthon Bridge

Guthon Bridge 是面向 Guthon 在线开发页面的本地辅助扩展，由 Chrome 扩展和本地 HTTP 桥接服务组成。

## 功能

- 在过程函数开发页识别当前脚本，并保存为本地文件。
- 在模块开发页打开复制模式，按页面块展示字段信息，便于复制和整理。
- 通过本地 HTTP 服务保存文件，并记录远端对象、本地路径和版本元数据。
- 后续可扩展为拉取模块开发页面内容和过程函数到工作副本。

## 目录

```text
plugins/GuthonBridge/
  bridge/       本地 HTTP 桥接服务
  extension/    Chrome 扩展
  package.json  启动和测试脚本
```

## 启动 Bridge

```bash
npm run start:bridge
```

默认监听：

```text
http://127.0.0.1:17361
```

健康检查：

```text
http://127.0.0.1:17361/health
```

临时切换端口：

```bash
GUTHON_BRIDGE_PORT=17362 npm run start:bridge
```

Chrome 扩展默认访问 `127.0.0.1:17361`，改端口后需要同步调整扩展代码或权限配置。

## 安装 Chrome 扩展

1. 打开 `chrome://extensions`
2. 开启“开发者模式”
3. 点击“加载已解压的扩展程序”
4. 选择 `plugins/GuthonBridge/extension/`

修改扩展代码后，需要在 Chrome 扩展页重新加载扩展，并刷新开发平台页面。

## 使用

### 拉取过程函数

1. 启动本地 bridge。
2. 打开过程函数开发页面。
3. 点击 Chrome 工具栏中的 `Guthon Bridge` 图标。
4. 确认弹窗识别到包名和函数名。
5. 填写本机绝对保存目录。
6. 点击 `拉取到本地`。

保存目录填写后，也可以直接使用页面上的 `拉取` 按钮。

### 打开复制模式

1. 打开模块开发页面。
2. 点击页面上的 `复制模式` 按钮，或点击 Chrome 扩展弹窗中的 `打开复制模式`。
3. 在弹窗中查看字段结构。
4. 从右侧文本框复制纯文本内容。

## 本地保存规则

- 保存目录必须是本机绝对路径。
- 保存目录不存在时会自动创建。
- 文件名来自当前函数名或片段名。
- 文件名会过滤路径非法字符。
- 同名文件会覆盖。
- 文件直接保存到填写的目录下，不再按包名创建子目录。

本地映射文件：

```text
bridge/workspace/manifest.json
```

## 不支持

- 本地文件回推到开发平台。
- 自动签出过程函数。
- 自动签出页面源码。

收到签出或回推命令时，插件会直接返回错误，不调用平台保存接口。

## 开发与验证

```bash
npm test
node --check bridge/server.js
node --check extension/content.js
node --check extension/page-bridge.js
node --check extension/popup.js
node --check extension/background.js
```

## 已知限制

- 复制模式依赖开发平台页面 DOM 和 Vue 实例结构，平台页面结构大改时需要同步调整。
- 模块开发主页面中复杂 tab/form/table 组合仍在继续兼容。
- 保存目录只能手动输入，还没有目录选择器。
