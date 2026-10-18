# Listen1 Mobile — 增强版

> **AI 作品声明**：本 fork 的全部增强修改（歌词错配修复 v2/v3、自动补词、B 站音源等）由 AI（腾讯 WorkBuddy 智能体）在人类指导下编写；上游 Listen1 代码归原作者所有。

> 一个聚合多家音乐源的免费音乐播放器（iOS / Android），基于 [Listen1 Mobile](https://github.com/listen1/listen1_mobile) 二次增强。

本项目是开源项目 **Listen1** 移动端（React Native）的一个**本地增强分支**。它完整保留了原版架构与界面，并针对“个人存档迁移 + 可完整播放 + 文件级备份恢复”做了三类增强。

---

## 原作者声明（必读）

本项目基于以下原始开源项目二次开发，原作者版权与许可均保留：

| 项目 | 原作者 | 原始 GitHub 链接 | 许可 |
|---|---|---|---|
| Listen1 Mobile（本分支的基座） | [listen1](https://github.com/listen1)（项目账号 / 维护组） | <https://github.com/listen1/listen1_mobile> | MIT |
| Listen1 Desktop（列表页/数据格式同源） | [listen1](https://github.com/listen1) | <https://github.com/listen1/listen1_desktop> | MIT |

- 原项目主页：<https://listen1.github.io/listen1>
- 原移动端详细说明见 [listen1/listen1_mobile](https://github.com/listen1/listen1_mobile)。

> **声明**：本仓库为**个人向的增强分支**，与原版开发者（listen1 团队）**无任何官方从属关系**。所有增强代码由本仓库作者维护，版权与问题请以本仓库为准。原版的问题/建议请提给上游。

---

## 与原版的差异（增强点）

原版 Listen1 Mobile（以 `listen1/listen1_mobile` `master` 为对照）在实测中存在几个痛点：

1. **B 站（bilibili）源被禁用**：`src/api/client.js` 里 `bilibili` 的 `import` 被注释掉，且项目里**根本没有 bilibili provider 文件**，导致存量 B 站链接的歌在手机端无法播放。
2. **歌源为会员/试听**：网易云、QQ 等歌源大量受会员限制，很多是 30 秒试听、`/nf/` 路径片段，无法完整播放。
3. **备份/恢复只有剪切板**：原版备份只是把 JSON 文本复制到剪切板，恢复靠“粘贴文本”，无法直接生成/消费 JSON 文件。

本分支的增强：

### 1. 找回并重写 B 站源（bilibili provider）
- 新增 `src/api/provider/bilibili.js`，并在 `client.js` 重新启用 `bilibili`。
- 播放走 **B 站 HTML5 单条完整 MP4 流**（`x/player/playurl?...&platform=html5&high_quality=1` 的 `durl[0].url`），**免登录、可完整播放**（实测 200 `video/mp4`，3.5~21MB）；无法用 HTML5 时回退 dash 音频流取最高带宽。
- 搜索用 `x/web-interface/search/type?search_type=video`，并对结果去除 `<em class="keyword">` 高亮标记。
- 支持 `favlist` 收藏夹（`x/v3/fav/resource/list`）。

### 2. 会员/不可播歌源自动换成免费完整源
本工程附带“存档迁移”转换器（不在本仓库内，位于工作区 `listen/`），把 PC 端 Listen1 导出的存档转换成移动端可用的 JSON，并做**逐首可播性探测**：
- 歌源判定：netease `weapi/song/enhance/player/url/v1`（`url=null` 即不可播）、kuwo 换完整 MP3 直链、kugou 校验 `PayType=0`、bilibili 走 HTML5 完整流。
- **完整曲启发式**：`content-length < 800000` 视为 30 秒试听片段，直接拒绝换源。
- 产出：`listen1_backup_mobile.json`（本仓库**不包含**该文件，属个人数据）。

### 3. 文件级备份/恢复（新增原生模块）
- 新增原生模块 **`FileManagerModule`**（`com.listen1.app`），不依赖任何第三方库。
- **备份**：设置 → 备份 → 「备份到文件」，自动生成 `listen1_backup_日期_时间.json`，优先写入手机 **Download** 目录，写不了则回落到应用专属目录（`Android/data/com.listen1.app/files/`），写入后显示完整路径。
- **恢复**：设置 → 恢复 → 文件列表里**点选** `.json` 备份文件即可载入预览，确认后「恢复」覆盖；列表按时间倒序，显示名称/日期/大小。原剪切板方式保留为备选。
- Manifest 增加 `READ/WRITE_EXTERNAL_STORAGE`，恢复页会按需申请存储权限。

### 4. 构建链修正（RN 0.59 老工程在 2026 年可复现构建）
- `yarn.lock` 已修正为可用 npm 源（原锁文件里的 `registry.npm.taobao.org` 已失效）。
- `android/build.gradle`：仓库列表补 **阿里云镜像 + mavenCentral**（原 `jcenter()` 已关停），并**全局强制 `react-native:0.59.9`**（否则会被 mavenLocal 里更高版本抢占导致编译失败）。
- Metro 0.55 的 Windows 正则 bug（`blacklist.js` 的 `/`→`path.sep` 缺转义前缀）已修复。
- `android/app/build.gradle`：`nodeExecutableAndArgs` 恢复为 `["node"]`（不再提交本机路径）。

---

## 环境要求

- **Node 12**（RN 0.59 的 metro 与 Node 24 不兼容，务必用 Node 12 打包 JS bundle）
- **JDK 8**（AGP 3.4 需要）
- **Gradle 5.4.1**（用项目自带 wrapper 或本地安装均可）
- **Android SDK 28**：`platforms;android-28` + `build-tools;28.0.3` + `platform-tools`
- Android SDK 根目录写入 `android/local.properties`：`sdk.dir=<你的SDK路径>`

> 若你本地用打包版 Node 12，可临时改 `nodeExecutableAndArgs` 为该路径（**不要提交**）。

---

## 运行（Debug）

```bash
npm install --registry=https://registry.npmmirror.com
cd android
./gradlew installDebug
# 另开一个终端（Node 12）启动 metro：
cd .. && npm start
```

## 构建发布版 APK（Release）

```bash
npm install --registry=https://registry.npmmirror.com
cd android
./gradlew assembleRelease --no-daemon
```

产物：`android/app/build/outputs/apk/release/app-release.apk`

### 签名（可选，发布前建议）
`release` 构建读取以下 Gradle 属性（来自 `android/gradle.properties`，仓库内已置空）：
`MYAPP_UPLOAD_STORE_FILE`、`MYAPP_UPLOAD_KEY_ALIAS`、`MYAPP_UPLOAD_STORE_PASSWORD`、`MYAPP_UPLOAD_KEY_PASSWORD`。

把 keystore 放在 `android/app/`（已被 `.gitignore` 排除），然后在本机 `~/.gradle/gradle.properties` 或本地 `android/gradle.properties` 填入真实值即可签名。**切勿把 keystore 或密码提交到仓库。**

> 本仓库 `source 里` `MYAPP_UPLOAD_*` 已清空（见 `android/gradle.properties`），因此直接 `assembleRelease` 会得到一个**未签名**的 release APK，可正常安装但无法上架/升级覆盖。要生成签名版，请按上面说明在本机补全签名属性。

### GitHub Actions 自动打包（可选）
仓库自带 `.github/workflows/build.yml`：push 到 `master` 后自动 `npm install` + `assembleRelease` 并上传 `app-release.apk` 到 Actions Artifacts。

- 该工作流里 `Decrypt large secret` 步骤需要仓库的 **Actions Secret `LARGE_SECRET_PASSPHRASE`**（用于解密上游的加密密钥 `.github/scripts/my-release-key.keystore.gpg`）。若你没设这个 secret，可删除该步骤，或用你自己的公开格式密钥。
- 若不想让 Actions 签名，可把 `build.gradle` 的 `signingConfig` 注掉，工作流会产出未签名 APK。

---

## 代码基本结构

```
src/
  api/
    client.js                 # 启用 bilibili 源（原版被注释）
    provider/
      bilibili.js             # 【新增】B 站 provider（HTML5 完整流）
      netease.js / kuwo.js / kugou.js / qq.js
  views/setting/
    export-local.screen.js    # 备份页：新增「备份到文件」
    import-local.screen.js    # 恢复页：新增「从文件恢复」文件列表
android/app/src/main/java/com/listen1/app/
  FileManagerModule.java      # 【新增】文件读写原生模块
  FileManagerPackage.java     # 【新增】模块注册
assets/                       # 图片等资源
components/                   # 可复用组件
modules/                      # 自定义函数库
redux/                        # action 和 reducer
```

---

## 免责声明
- 聚合播放功能均来自各音乐平台**自有/公开接口**，本仓库不存储任何音频数据；请勿用于商业用途，尊重各平台版权。
- B 站、网易云等接口可能随时变动，若失效请以各自平台政策为准。
- 本仓库**未包含**任何用户“个人存档”（备份 JSON）或签名私钥/密码。

## 鸣谢（来自原版）
- [git-point](https://github.com/gitpoint/git-point)：原版开发环境搭建参照。
- [Binaryify/NeteaseCloudMusicApi](https://github.com/Binaryify/NeteaseCloudMusicApi)：网易 API。
- [yezihaohao/NeteaseCloudMusic](https://github.com/yezihaohao/NeteaseCloudMusic)：网易 RN 端参考。
- [soimort/you-get](https://github.com/soimort/you-get)：音乐下载参考。
- 以及所有为开源社区贡献代码的开发者。

## License

MIT —— 原始版权归 [listen1](https://github.com/listen1) 团队。本分支增强代码按 MIT 一并发布。

> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
