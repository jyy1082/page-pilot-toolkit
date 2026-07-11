# page-pilot-toolkit

**中文** · [English](./README.md)

**版本 0.6.0** · 完整版本历史见 [CHANGELOG.md](./CHANGELOG.md)

一个浏览器书签（bookmarklet），点一下就能在当前网页上弹出一个"录制/运行"面板——不用装任何东西，不用浏览器扩展，不用构建。把一个链接拖到收藏夹栏，在任意网站点它就行。

完全基于两个已有的库搭建：
- [page-pilot](https://github.com/jyy1082/page-pilot)——带着可见的光标、点击涟漪、高亮边框，把录制好的一套操作回放出来，清楚地看到"系统正在做什么、在哪做"。
- [page-pilot-recorder](https://github.com/jyy1082/page-pilot-recorder)——把真实的点击/打字/选择转换成 page-pilot 的 `run()` 能直接吃的步骤数组。

`toolkit.js` 是把两者粘合起来的那层：一个带 开始/停止/运行/复制 的小悬浮面板，由书签负责加载。

## 安装

**[打开安装页面](https://jyy1082.github.io/page-pilot-toolkit/install.html)**，把上面那个按钮拖到你的收藏夹栏。（"拖"才是安装方式——在那个页面上直接点击它没什么实际用处，因为那个演示页面本身没什么值得录制的内容。）

## 用法

1. 打开任意网站，点一下 **PagePilot** 这个收藏夹。
2. 角落会出现一个面板。点 **Start recording**，然后正常操作页面——打字、点击、选择，随便什么任务需要的都行。
3. 点 **Stop**。录制到的步骤会以 JSON 形式显示在框里——需要的话可以自己改。
4. 点 **Run** 直接在当前页面回放一遍，或者点 **Copy** 把 JSON 复制出去（贴到你自己代码里的 `cursor.run(steps)` 里）。
5. 也可以直接把自己手写的步骤数组粘贴进框里，点 Run 直接跑——不一定非要先录制。

如果某一步导致某个 iframe 重新加载内容（内嵌支付组件、多步骤表单很常见这种情况），面板会自动等这次重新加载完成再继续，不需要手动加等待步骤——毕竟在这里没法方便地去手动改录制出来或者粘贴进来的 JSON。

如果前一步其实没有真的把某个弹窗关掉，面板会拒绝穿透它的蒙版去操作背后的内容——真实鼠标本来就碰不到那里，所以这里会直接停下来报一个清楚的错误，而不是悄悄操作了错的东西。

## 有意不做的事

- **不会在多次访问之间保存任何东西。** 关掉标签页（或者关掉面板），框里的内容就没了。故意不做"保存多个流程"这种功能——想留着的话，先把 JSON 复制出去。
- **任何网站都不会录制密码框**，这是在 page-pilot-recorder 库本身里强制写死的规则，不是这一层额外加的。
- **不是所有网站都能用。** 有些网站设置了严格的内容安全策略（CSP），会直接拦截书签注入的外部 `<script>`——面板根本不会出现（会弹一个提示说明情况）。这是网站自己的安全设置，书签这个层面没有权限绕过去，浏览器扩展可以，书签不行。

## 安全性说明

- 你在哪个页面上运行这个书签，它就拥有你浏览器会话在那个页面上**本来就有**的访问权限——跟任何书签或者用户脚本一样。不要在你不放心随便粘贴 JavaScript 代码进去的地方运行它。
- `page-pilot.js` 和 `page-pilot-recorder.js` 是从 [jsDelivr](https://www.jsdelivr.net/) 按**锁定的版本号**加载的，不是跟着它们的 `main` 分支走——这样这两个库以后的更新，不会悄悄改变一个已经装好的书签的行为。升级方式见下面"更新"部分。
- 面板本身渲染在一个封闭的 [Shadow DOM](https://developer.mozilla.org/zh-CN/docs/Web/API/Web_components/Using_shadow_DOM) 里，宿主页面自己的 CSS 没法把它的样式弄乱，面板自己的样式也不会泄漏出去影响宿主页面。

## 更新

书签的地址锁定在某个具体版本（`page-pilot-toolkit@0.6.0`，以及 `toolkit.js` 内部锁定的 page-pilot / page-pilot-recorder 版本号）。哪怕这个仓库之后有改动，已经装好的书签也会一直保持原来的行为不变——想用新版本，重新打开安装页面，再拖一次（更新过的）按钮就行。

## 测试

```bash
npm install
npm test
```

跑的是真实浏览器测试（Playwright + Chromium，通过 `@sparticuz/chromium` 拿到——具体原因见 [page-pilot-recorder 的 README](https://github.com/jyy1082/page-pilot-recorder#testing)），模拟点击书签、像真实用户一样操作生成的 Shadow DOM 面板，验证"录制→运行"闭环、密码框排除、关闭再重新打开面板都能正常工作。这个沙盒环境访问不到 jsDelivr，所以测试用的是本地 vendor 进来的 page-pilot.js/page-pilot-recorder.js 副本，而不是真实的 CDN 地址。

## 协议

MIT
