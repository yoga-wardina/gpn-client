# GPN Client tray icon (runs hidden, controlled by files in the app dir)
param([string]$Port = "7790", [string]$StateDir = ".")

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$exitFlag = Join-Path $StateDir "tray.exit"
if (Test-Path $exitFlag) { Remove-Item $exitFlag -Force }

$icon = New-Object System.Drawing.Icon((Join-Path $StateDir "assets\gpn.ico"))
# fallback: default application icon if custom .ico missing
if (-not $icon) { $icon = [System.Drawing.SystemIcons]::Application }

$notify = New-Object System.Windows.Forms.NotifyIcon
$notify.Icon = $icon
$notify.Text = "GPN Client - running (port $Port)"
$notify.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$menu.Items.Add("Open Dashboard", $null, {
    param($s, $e)
    Start-Process "http://localhost:$Port"
}) | Out-Null
$sep = $menu.Items.Add("-")
$menu.Items.Add("Quit", $null, {
    param($s, $e)
    $notify.Visible = $false
    [System.Windows.Forms.Application]::ExitThread()
}) | Out-Null
$notify.ContextMenuStrip = $menu

# double-click opens dashboard too
$notify.add_DoubleClick({ Start-Process "http://localhost:$Port" })

# balloon on first show
$notify.ShowBalloonTip(3000, "GPN Client", "Running in the background. Double-click the icon to open the dashboard.", [System.Windows.Forms.ToolTipIcon]::Info)

# poll for exit flag from the host process
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 500
$timer.Add_Tick({
    if (Test-Path $exitFlag) {
        $notify.Visible = $false
        [System.Windows.Forms.Application]::ExitThread()
    }
})
$timer.Start()

[System.Windows.Forms.Application]::Run()
