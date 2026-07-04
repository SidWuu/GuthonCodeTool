# Guthon Bridge TODO

## 当前结论

- 本目录只维护浏览器扩展和本地 bridge，不提交业务源码。
- 开发调试依赖用户本机已登录的开发平台页面。
- 文档示例只保留通用功能说明，不记录真实业务页面、接口地址、表结构或截图路径。

## 后续方向

1. 将过程函数拉取目标接入 GuthonCodeTool 的工作副本目录。
2. 增加模块开发页面内容拉取能力。
3. 复制模式继续兼容复杂表单、标签页和表格组合。
4. 保存目录支持更友好的选择方式。
5. 增加针对页面结构变化的最小回归用例。

## 验证入口

```bash
npm test
node --check bridge/server.js
node --check extension/content.js
node --check extension/page-bridge.js
node --check extension/popup.js
node --check extension/background.js
```
