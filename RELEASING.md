# 发布流程

**GitHub Release 的说明必须双语**（`## 中文` 段在前，`## English` 段在后）。
插件的使用者里既有中文也有非中文用户，单语说明会让另一半人完全看不懂改了什麼。

## 三步

1. **打包** —— 一条命令产出一个 tarball，后面两个渠道共用同一份：

   ```bash
   npm pack --pack-destination /tmp
   ```

2. **建 Release 并上传那个 tarball** —— tag 与 `package.json` 的 `version` 一致
   （`vX.Y.Z`），说明按下面的模板写。

3. **把同一个 tarball 发到 npm**：

   ```bash
   npm publish dsh-thinking-slider-X.Y.Z.tgz --registry=https://registry.npmjs.org
   ```

   > 本机 `~/.npmrc` 的默认 registry 是镜像站，**必须显式指定官方源**，否则会报
   > 权限/404，或者发到了镜像上。

这样 release 附件与 npm 上的包**字节一致**（同一个 shasum），插件市场从哪边装都一样。

## 说明模板

```markdown
## 中文

**dsh-thinking-slider X.Y.Z**

- 修复：<一句话说明现象与原因，带关键 token / 版本 / 数值>
- <N> 项行为检查通过（`node test/smoke.mjs`）。

## English

**dsh-thinking-slider X.Y.Z**

- Fixed: <同一条事实，同样的顺序与数字>
- <N> behaviour checks pass (`node test/smoke.mjs`).

---

**安装 / Install**

```bash
dsh plugin --profile <name> add github:MuFeng262/dsh-thinking-slider
npm i dsh-thinking-slider
```

**附件 / Asset**：`dsh-thinking-slider-X.Y.Z.tgz` 是预构建包，供插件市场一条命令安装，与 npm 上的包字节一致。
The attached tarball is the prebuilt package for one-command install in plugin markets, byte-identical to the npm release.
```

## 硬性要求

- 两个语言段的**条目数量、顺序、事实必须一致**。只在一边写的修复等于漏写。
- 版本号、token 名、命令一律加反引号。
- 报告问题的人要署名（`@handle` + issue 号），两个语言段都写。
- 测试条数写**实际值**（`node test/smoke.mjs` 的输出），不要沿用旧数字。
- 「安装 / Install」与「附件 / Asset」只写一次，放在 `---` 之后，两段共用。
