# DevCatToolRegistry import tool

The companion tool for [DevCatToolRegistry](../DevCatToolRegistry): browse the
registry, verify a payload, install it, and record a receipt so it can be removed
cleanly later.

**Language**: [English](README.en.md) · [中文](README.zh-CN.md)

---

## Documentation · 文档

| | English | 中文（主） |
| --- | --- | --- |
| Overview 总览 | [README.en.md](README.en.md) | [README.zh-CN.md](README.zh-CN.md) |
| Architecture 架构 | [docs/architecture.en.md](docs/architecture.en.md) | [docs/architecture.zh-CN.md](docs/architecture.zh-CN.md) |
| Decisions 决策记录 | [docs/decisions.en.md](docs/decisions.en.md) | [docs/decisions.zh-CN.md](docs/decisions.zh-CN.md) |
| Changelog 变更记录 | [CHANGELOG.en.md](CHANGELOG.en.md) | [CHANGELOG.zh-CN.md](CHANGELOG.zh-CN.md) |
| Unity front end Unity 前端 | [frontends/unity-editor/README.md](frontends/unity-editor/README.md) | 待补（见下） |

`frontends/unity-editor/README.md` is still English-only, unlike everything else here.
It documents how to drop the Editor assembly into a project and why the front end is
deliberately thin, both of which overlap
[docs/architecture](docs/architecture.zh-CN.md); a Chinese version is pending rather
than intentionally absent.

`frontends/unity-editor/README.md` 目前仍是纯英文，与本仓库其它文档不一致。它讲的是如何把
Editor 程序集放进工程、以及前端为什么刻意做薄——这两点与
[docs/architecture.zh-CN.md](docs/architecture.zh-CN.md) 有重叠。中文版是**待补**，不是有意省略。

The normative data contract lives in the registry repository:
[`../DevCatToolRegistry/docs/FRONTEND-INTEGRATION.zh-CN.md`](../DevCatToolRegistry/docs/FRONTEND-INTEGRATION.zh-CN.md)
(English: [`…en.md`](../DevCatToolRegistry/docs/FRONTEND-INTEGRATION.en.md)).

规范性的数据契约在注册库仓库里，本仓库只实现它。

---

## Quick start · 快速开始

```pwsh
npm install                                                # the only dependency is `yaml`

node apps/cli/bin/utool.js list     --registry ../DevCatToolRegistry
node apps/cli/bin/utool.js validate ../DevCatToolRegistry
npm test                                                   # 41 tests, both suites
npm run check:csharp                                       # type-check the Unity C# with no Unity
```

Layout and rationale: see the per-language overview documents above.
目录结构与设计理由见上面各语言的总览文档。
