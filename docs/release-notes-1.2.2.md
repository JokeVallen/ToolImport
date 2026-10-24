# ToolImport 1.2.2

修一个“在旧 Node 上根本启动不了”的缺陷，并把最低版本改成真实值。

A fix for a crash before startup on older Node, and an honest minimum version.

## 修了什么 / What changed

1. **旧 Node 上整个工具加载失败** —— `containers.js` 用具名导入取 `zstdDecompressSync`，而具名导入
   在模块链接阶段解析：Node 的 zlib 没有这个导出时，模块根本没跑起来，所以文件里那句“没有 zstd 编解码器”
   的提示永远不会执行。用户看到的是 `node:zlib` 的错误，既没提这个工具，也没提该升到哪。
   现在改为命名空间导入，提示能正常出现。
2. **最低 Node 版本 20.11 → 22.15** —— zstd 解码器是 Node 22.15 才进 `node:zlib` 的。按旧声明装好的
   环境会在加载校验器时崩溃。

## 怎么发现的 / How it surfaced

发布的 Registry 起步包第一次跑 CI（Node 20）就红了，报的是
`The requested module 'node:zlib' does not provide an export named 'zstdDecompressSync'`。
一个只在自己机器（Node 24）上跑过的项目，不会自己发现这件事。

## 升级 / Upgrade

覆盖目录即可，版本号在 Godot 窗口右下角与 Unity 状态行右端可见。**Node 必须 22.15 以上。**

---

## 验证 / Verification

- `npm test` 114 项通过，新增 `node-floor.test.js`：钉住 22.15，并禁止 `node:zlib` 的 zstd 具名导入
- 发布的起步包仓库 CI 由失败转为通过
