# 更新与发布

## 版本号

整个项目只有一个版本号：根目录 `package.json` 的 `version`。中转服务（`/v1/health` 里的 `version`）和电脑端（`herdr-pocket version`）都从这里读。发布时 `scripts/set-version.mjs` 把它同步到各个包和 Android App 的 `app.json`（`version`）；App 的构建插件再由它算出 `versionCode = 主版本×1000000 + 次版本×1000 + 修订号`（例如 1.2.3 → 1002003），保证每次更新的 versionCode 都更大。

## 一次发布里有什么

打 `vX.Y.Z` 标签后，`.github/workflows/release.yml` 生成 GitHub Release：

| 文件 | 用途 |
|---|---|
| `herdr-pocket-X.Y.Z.tar.gz` | 中转服务 + 电脑端的发布包，已带生产依赖，不分系统和 CPU。安装脚本和 `update` 用它 |
| `herdr-pocket-X.Y.Z-android-arm64.apk` | Android App。App 内更新用它 |
| `herdr-pocket-X.Y.Z-ios-unsigned.ipa` | iOS 未签名安装包（侧载使用） |
| `herdr-pocket-X.Y.Z-harmony-unsigned.hap` | HarmonyOS NEXT 未签名安装包 |
| `herdr-pocket-X.Y.Z-macos-{arm64,x64}.dmg` | macOS 桌面端安装包（Apple Silicon / Intel） |
| `herdr-pocket-X.Y.Z-windows-x64-{setup.exe,.msi}` | Windows 桌面端安装包 |
| `herdr-pocket-X.Y.Z-linux-x86_64.{AppImage,deb}` | Linux 桌面端安装包 |
| `RELEASE-NOTES.md` | 该版本的中文详细更新公告，桌面端镜像线路可直接拉取展示 |
| `SHA256SUMS` | 上述发布文件的 SHA256，安装脚本、桌面端和 `update` 下载后都会核对 |

同时推送镜像 `ghcr.io/<owner>/herdr-pocket-relay:X.Y.Z`、`:X.Y` 和 `:latest`（amd64 + arm64）。带 `-rc.1` 这类后缀的标签发布为预发布，不打 `latest`，也不会被 `update` 选中。

## 各部分怎么更新

| 部分 | 命令 | 做了什么 |
|---|---|---|
| 电脑端 | `herdr-pocket update` | 查 GitHub 最新 Release → 下载发布包并核对 SHA256 → 解压到 `releases/<版本>` → 试启动一次 → 切换 `current` → 重启 launchd / systemd 服务。`--rollback` 退回上一个版本 |
| 中转服务（Node + systemd） | `sudo herdr-pocket-relay update` | 同上，重启 `herdr-pocket-relay.service` |
| 中转服务（Docker） | `sudo herdr-pocket-relay update` | `docker compose pull && docker compose up -d`，数据卷保留 |
| Fly.io / 其他平台 | 重新部署 | 重新拉 `latest` 镜像 |
| 手机 App | App 内提示 | 下载 APK 安装 |

说明：

- `update` 只会重启属于这份安装的服务（服务文件里写着这个安装目录）；别的方式装的不会碰，只提示你自己重启。
- 只保留当前和上一个版本，更早的自动删掉。
- 发布包缺失时（比如手动建的 Release），`update` 退回到 GitHub 的源码包，这时需要本机有 pnpm。
- 想从自己的 fork 更新：`HERDR_POCKET_REPO=<owner>/<repo> herdr-pocket update`；安装脚本同样认这个变量。
- 查询 GitHub 有频率限制（未登录每小时 60 次），设置 `GITHUB_TOKEN` 可以放宽。

电脑端还会查它依赖的 hc（herdr-core）、Herdr 桌面版和 uniflo 有没有新版本：启动后几分钟查一次，之后大约每天一次，只报告，不安装。hc 看 Herdr 发布服务器的 `core/latest.json`（设了 `HERDR_RELEASES_URL` 就用它），只有和正在运行的 hc 同一代（`generation`）的版本才算可更新；Herdr 桌面版装了才查 `app/latest.json`；uniflo 用它自己的 `uniflo update --check --json`。离线时保留上次的结果。每次的结果写进日志（`herdr-pocket logs --kind update`），`herdr-pocket status` 的 `upstream` 一行能看到。`update.checkTools: false` 可以关掉，详见[配置说明](../config.md#updates-of-hc-the-herdr-app-and-uniflo)。

### 中国大陆

在中国大陆直连 GitHub 很慢或者连不上（2026-11 实测：直连下载 APK 约 100 KB/s，`herdr-pocket update` 直连失败），所以先判断设备在哪个地区，再决定先找哪些下载源：

- 地区按这个顺序定：先看 `HERDR_POCKET_MIRROR`（`1` 或 `cn` 先走镜像，`0` 或 `global` 先走 GitHub）；没设就看 `config.json` 里的 `update.region`（`cn`、`global`，`auto` 等于没写，见[配置说明](../config.md#computers-and-the-desktop-app-configjson)）；再没有就看时区，时区是中国大陆的（`Asia/Shanghai` 等；Windows 是“China Standard Time”）算中国大陆。电脑端、中转服务和安装脚本都按这个顺序。
- 下载源的顺序：`update.mirrors` 里自己配的镜像排最前；中国大陆接着是 `ghfast.top`、`gh-proxy.com`、`cdn.gh-proxy.com`、`edgeone.gh-proxy.com`，最后才是 GitHub；其他地区 GitHub 在前，镜像在后。
- 不是一个一个地试：查新版本时同时向所有源要最新 Release 的 `SHA256SUMS`，每个最多等 4 秒，第一个回答后其他的再等 150 ms，然后选最快的；两个源差不到 150 ms 时，排在前面的优先。选中的源记一天（`~/.local/state/herdr-pocket/sources.json`，Windows 在 `%LOCALAPPDATA%\herdr-pocket\sources.json`），这一天里查新版本和下载都先找它，下载失败再按上面的顺序换下一个。所有源都没在时限内回答时，才一个一个慢慢试，GitHub API 也在其中（中国大陆放最后，其他地区放最前）。
- `herdr-pocket update --check` 会说地区是怎么定的、哪个源回答的、用了多久；`herdr-pocket update --probe` 当场把所有源测一遍，打印每个的用时，并记下最快的。
- 电脑端自动查新版本：启动后 1 到 5 分钟查第一次，之后每隔 `update.checkIntervalHours`（默认 24 小时，前后随机差 10%，免得很多电脑同时查）。每次查的结果、来源和用时都写进日志（`herdr-pocket logs --kind update`）。设 `HERDR_POCKET_UPDATE_CHECK=0` 或 `update.autoCheck: false` 就不自动查。
- 安装脚本（`install-host.sh`、`install-host.ps1`）下载前也会这样测一遍，但只用内置的镜像，不读 `update.mirrors`。
- 版本信息读的是最新 Release 的 `SHA256SUMS`。镜像能转发这个文件，但转发不了 GitHub API。
- 安装脚本要下载 Node 时，校验值总是取自 nodejs.org，Node 安装包本身在中国大陆先从 `npmmirror.com` 下载。
- 不管从哪里下载，都会核对 `SHA256SUMS`。手机端 Android 还会检查签名，只接受同一把密钥签名的更新包。
- 服务器时区常常是 UTC：设 `HERDR_POCKET_MIRROR=1` 强制先走镜像，设成 `0` 则先走 GitHub；也可以在 `config.json` 里写 `update.region`。
- 手机 App 只看手机的时区，也不测速。这套逻辑从 0.1.4 起才有，0.1.3 及以前的 App 还是直连 GitHub。

## 发布步骤（强制包含更新公告）

每次发版打 tag 时，**必须**随版本提交一份详细的中文更新公告并用它生成附注标签（annotated tag），确保 GitHub Release 页面和客户端应用内更新弹窗都能展示完整说明：

1. 编写详细公告文件 `docs/releases/vX.Y.Z.md`，建议包含：
   - `# Herdr Pocket vX.Y.Z 更新公告`
   - `## 更新亮点`
   - `## 新增功能`
   - `## 交互与体验优化`
   - `## 问题修复`
   - `## 多端与升级说明`
   > 公告内容面向用户，禁止写入私有域名、IP、本机路径、签名 ID 或敏感凭据。
2. 同步版本号并提交公告与代码：

```sh
node scripts/set-version.mjs X.Y.Z
git add -A && git commit -m "release: vX.Y.Z"
git tag -a vX.Y.Z -F docs/releases/vX.Y.Z.md
git push origin main vX.Y.Z
```

3. 工作流 `.github/workflows/release.yml` 会读取 `docs/releases/vX.Y.Z.md`（若缺失则回退读取 `vX.Y.Z` 附注标签正文；若两者均为空或过短则直接失败阻断发布），生成 `dist/RELEASE-NOTES.md` 写入 `SHA256SUMS`，并将完整公告置顶写入 GitHub Release 说明（即使该标签对应的 Release 已提前创建，也会通过 `gh release edit` 同步更新说明）。
4. 若本地额外构建并上传公证后的 macOS DMG，需一并更新该版本的 `SHA256SUMS`（覆盖含 `RELEASE-NOTES.md` 在内的全部资产），并用 `gh release view vX.Y.Z` 核对 Release 顶部公告与全部资产是否完整无误。
5. 已经存在的标签可在 Actions 里手动运行 Release 重新构建（`workflow_dispatch`，填标签），产物和公告都会同步刷新。

## Android 签名

本地构建和 CI 用同一把密钥、同一种方式签名：Gradle 的 `-Pandroid.injected.signing.*` 参数。密钥只生成一次，放在仓库外面。

### 1. 生成自己的密钥（fork 也一样）

```sh
keytool -genkeypair -v -keystore /path/to/herdr-pocket-release.jks \
  -alias herdr-pocket -keyalg RSA -keysize 4096 -validity 10000
```

`keytool` 会交互地问密码，密码不会留在 shell 历史里。把 keystore 文件放在仓库以外的位置，密码存进系统钥匙串或密码管理器。默认的 PKCS12 格式里密钥密码和 keystore 密码是同一个。

### 2. 本地签名构建

```sh
cd apps/mobile
pnpm install --ignore-workspace
pnpm exec expo prebuild --platform android --no-install   # android/ 不进仓库，第一次和改了 app.json 后要跑
cd android
./gradlew assembleRelease -PreactNativeArchitectures=arm64-v8a -Pexpo.webp.animated=true \
  -Pandroid.injected.signing.store.file=/path/to/herdr-pocket-release.jks \
  -Pandroid.injected.signing.store.password="$ANDROID_KEYSTORE_PASSWORD" \
  -Pandroid.injected.signing.key.alias=herdr-pocket \
  -Pandroid.injected.signing.key.password="$ANDROID_KEYSTORE_PASSWORD"
```

密码从环境变量取，不要直接写在命令里。macOS 上可以先从钥匙串读出来，例如 `export ANDROID_KEYSTORE_PASSWORD=$(security find-generic-password -s <钥匙串条目名> -w)`。产物在 `app/build/outputs/apk/release/app-release.apk`。不带这四个参数时，APK 用 debug 密钥签名。

核对签名：`apksigner verify --print-certs app-release.apk`。本地包和 CI 包的 `SHA-256` 指纹应该一样。

### 3. CI 用的四个 Secret

在 GitHub 仓库 Settings → Secrets and variables → Actions 里加：

| Secret | 内容 |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | keystore 文件的 base64：macOS `base64 -i /path/to/herdr-pocket-release.jks`，Linux `base64 -w0 /path/to/herdr-pocket-release.jks` |
| `ANDROID_KEYSTORE_PASSWORD` | keystore 密码 |
| `ANDROID_KEY_ALIAS` | 密钥别名（上面例子里是 `herdr-pocket`） |
| `ANDROID_KEY_PASSWORD` | 密钥密码；和 keystore 密码相同可不填 |

`release.yml` 把 keystore 解码到 runner 的临时目录，再用上面同样的 `-Pandroid.injected.signing.*` 参数构建。每次构建的签名证书指纹会写在工作流的 Summary 里。

没配这些 Secret 时，APK 用公开的 debug 密钥签名，工作流会给出警告。这样的包可以拿来测试，但任何人都能用同一个密钥签出“更新”，不要发给用户。

### 密钥丢了就不能原地更新

Android 只接受和已装 App 签名相同的更新。keystore 文件或密码一旦丢失，所有已经装上的 App 都没法再覆盖更新（包括 App 内更新），只能卸载重装，卸载后要重新配对。所以 keystore 和密码至少要另外备份一份，也放在仓库以外。

同理，换签名就要卸载重装：从 debug 签名的测试包换到正式签名的包，需要卸载重装一次。fork 如果没改包名，用自己的密钥签出的 APK 不能覆盖安装官方签名的 App，反过来也不行。

## CI

`.github/workflows/ci.yml` 在推送到 main 和每个 PR 上运行：安装依赖、类型检查、relay / hostd / update 测试、shellcheck 检查安装脚本、打一次发布包、Android App 类型检查、构建一次中转服务镜像（不推送）。
