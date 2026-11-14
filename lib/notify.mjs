// 系统通知：macOS 用 osascript，Windows 用 PowerShell Toast；文本都通过参数/环境变量传入，不拼进脚本
import { execFile } from 'node:child_process';

const WIN_TOAST = `
$ErrorActionPreference = 'SilentlyContinue'
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
$t = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$n = $t.GetElementsByTagName('text')
$n.Item(0).AppendChild($t.CreateTextNode($env:AEPS_TITLE)) > $null
$n.Item(1).AppendChild($t.CreateTextNode($env:AEPS_MESSAGE)) > $null
$app = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($app).Show([Windows.UI.Notifications.ToastNotification]::new($t))
`;

export function systemNotify(title, message, platform = process.platform) {
  const t = String(title).slice(0, 120);
  const m = String(message).slice(0, 220);
  if (platform === 'darwin') {
    const script = ['on run argv', 'display notification (item 2 of argv) with title (item 1 of argv) sound name "Glass"', 'end run'];
    execFile('osascript', [...script.flatMap((line) => ['-e', line]), t, m], () => {});
  } else if (platform === 'win32') {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WIN_TOAST], {
      windowsHide: true,
      env: { ...process.env, AEPS_TITLE: t, AEPS_MESSAGE: m },
    }, () => {});
  }
}
