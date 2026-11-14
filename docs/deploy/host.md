# 电脑端：安装、上线、更新

macOS 和 Linux 都是一条命令，用你自己的用户运行，不需要 sudo：

```sh
curl -fsSL https://raw.githubusercontent.com/Crosery/herdr-pocket/main/scripts/install-host.sh | bash -s -- --server https://pocket.example.com
```

脚本会：

1. 找一个 Node 22.18 以上；没有就下载 Node 24 到 `~/.local/share/herdr-pocket/node`（校验 SHA256）。
2. 把最新发布包装到 `~/.local/share/herdr-pocket/releases/<版本>`，`current` 指向它。
3. 写好命令 `~/.local/bin/herdr-pocket`（如果这个目录不在 PATH 里会提示怎么加）。
4. 登记这台电脑：终端显示二维码，用已经连上的手机在 App 里“设备 → 扫一扫”扫码并允许。
5. 装成后台服务并启动，开机/登录后自动上线：
   - macOS：`~/Library/LaunchAgents/com.herdr-pocket.hostd.plist`，日志在 `~/Library/Logs/herdr-pocket/hostd.log`
   - Linux：`~/.config/systemd/user/herdr-pocket-hostd.service`，日志 `journalctl --user -u herdr-pocket-hostd -f`；会尝试 `loginctl enable-linger`，让你退出登录后也保持在线

已经登记过的电脑重跑脚本不会重复登记，只更新程序和服务。

## 常用参数

| 参数 | 作用 |
|---|---|
| `--server <地址>` | 你的中转服务 |
| `<设置或邀请链接>` | 直接用链接登记，不用扫码。新中转服务还没有手机时，用它启动时打印的设置链接（`https://<服务器>/p/<码>`） |
| `--code <码>` | 和 `--server` 一起用，效果同上 |
| `--name <名字>` | 设备名，默认是电脑名 |
| `--read-only` | 手机和其他电脑只能看，不能输入 |
| `--no-service` | 只装命令，不装后台服务；之后自己运行 `herdr-pocket up` |
| `--version <x.y.z>` | 装指定版本 |

例如新中转服务上的第一台设备是电脑：

```sh
curl -fsSL https://raw.githubusercontent.com/Crosery/herdr-pocket/main/scripts/install-host.sh | bash -s -- https://pocket.example.com/p/ABCD-1234
```

## 更新

```sh
herdr-pocket update              # 装最新版本并重启后台服务
herdr-pocket update --check      # 只看有没有新版本
herdr-pocket update --rollback   # 退回上一个版本
herdr-pocket version
```

新版本先解压到 `releases/` 并试启动一次，没问题才切换并重启；失败时原来的版本照常运行。后台运行的 `herdr-pocket` 每天检查一次，有新版本时在日志里提示一行（`HERDR_POCKET_UPDATE_CHECK=0` 关掉）。

用 git 仓库直接运行的（开发用），`update` 会提示改用 `git pull && pnpm install`。

## 查日志

```sh
herdr-pocket logs                          # 最近 1 小时中转服务、电脑和手机记下的日志
herdr-pocket logs --level warn --since 1d  # 只看警告和错误
herdr-pocket logs --device <设备名> -f      # 盯着一台设备
```

`herdr-pocket help` 列出全部过滤参数。这台电脑后台服务自己的输出在上面第 5 步写的位置。

## 服务管理

macOS：

```sh
launchctl kickstart -k gui/$(id -u)/com.herdr-pocket.hostd   # 重启
launchctl bootout gui/$(id -u)/com.herdr-pocket.hostd        # 停止并取消开机启动
```

Linux：

```sh
systemctl --user restart herdr-pocket-hostd
systemctl --user disable --now herdr-pocket-hostd
```

## 卸载

1. 停掉服务（上面的 bootout / disable）并删除 plist 或 unit 文件。
2. 删除 `~/.local/share/herdr-pocket` 和 `~/.local/bin/herdr-pocket`。
3. 在手机 App 的设备列表里删掉这台电脑（或保留 `~/.config/herdr-pocket/hostd.json` 以便以后重装时沿用登记）。
