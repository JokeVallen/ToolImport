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
| Architecture 架构（含 Unity 前端） | [docs/architecture.en.md](docs/architecture.en.md) | [docs/architecture.zh-CN.md](docs/architecture.zh-CN.md) |
| Decisions 决策记录 | [docs/decisions.en.md](docs/decisions.en.md) | [docs/decisions.zh-CN.md](docs/decisions.zh-CN.md) |
| Changelog 变更记录 | [CHANGELOG.en.md](CHANGELOG.en.md) | [CHANGELOG.zh-CN.md](CHANGELOG.zh-CN.md) |

The Unity front end has no README of its own: it lives in the architecture document,
under *Unity front end*, in both languages. It used to have a separate English-only
README, which duplicated the architecture section and would eventually have disagreed
with it — a duplicate document drifts, and this project already had to retire one stale
architecture document for exactly that reason. `frontends/unity-editor/` now contains
only the C# sources and their assembly definition.

Unity 前端**没有**自己的 README：它就在架构文档的「Unity 前端」一节里，中英各有。它原来有一份
独立的纯英文 README，与架构文档重复，迟早会与之矛盾——重复的文档必然漂移，而本项目已经因为同一
原因退役过一份过期架构文档。现在 `frontends/unity-editor/` 下只有 C# 源码与程序集定义。

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
