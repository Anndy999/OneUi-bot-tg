$ErrorActionPreference = "Stop"

$WorkerUrl = "https://oneui-firmware-worker.annndy0950-oneui.workers.dev"

Write-Host "OneUI Firmware Worker cleanup" -ForegroundColor Cyan
Write-Host "This script clears old Telegram command menus and resets the webhook."
Write-Host "Token will not be written to project files." -ForegroundColor Yellow
Write-Host ""

Set-Location $PSScriptRoot

function Invoke-TelegramApi {
  param(
    [Parameter(Mandatory=$true)][string]$Token,
    [Parameter(Mandatory=$true)][string]$Method,
    [Parameter(Mandatory=$false)]$Body
  )
  $uri = "https://api.telegram.org/bot$Token/$Method"
  if ($null -eq $Body) {
    return Invoke-RestMethod -Uri $uri -Method Post
  }
  return Invoke-RestMethod -Uri $uri -Method Post -ContentType "application/json" -Body ($Body | ConvertTo-Json -Depth 8 -Compress)
}

function Delete-CommandsForScope {
  param(
    [string]$Token,
    [hashtable]$Scope,
    [string]$Label
  )
  try {
    $resp = Invoke-TelegramApi -Token $Token -Method "deleteMyCommands" -Body @{ scope = $Scope }
    Write-Host "deleteMyCommands $Label ok: $($resp.ok)"
  } catch {
    Write-Host "deleteMyCommands $Label failed: $($_.Exception.Message)" -ForegroundColor Yellow
  }
}

$tokenSecure = Read-Host "Paste TELEGRAM_BOT_TOKEN from BotFather" -AsSecureString
$tokenPtr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($tokenSecure)
$token = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($tokenPtr)
[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($tokenPtr)

if ([string]::IsNullOrWhiteSpace($token)) {
  throw "TELEGRAM_BOT_TOKEN is empty."
}

Write-Host ""
Write-Host "Checking Telegram token..." -ForegroundColor Cyan
$me = Invoke-TelegramApi -Token $token -Method "getMe"
Write-Host "Bot ok: @$($me.result.username)"

$webhookSecret = Read-Host "Enter WEBHOOK_SECRET (press Enter to generate a new one)"
if ([string]::IsNullOrWhiteSpace($webhookSecret)) {
  $chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789".ToCharArray()
  $webhookSecret = -join (1..32 | ForEach-Object { $chars | Get-Random })
}

$chatId = Read-Host "Enter TELEGRAM_CHAT_ID for monitor notifications (optional, press Enter to keep current secret)"
$adminIdsRaw = Read-Host "Enter old admin chat IDs to clear admin command scopes (comma separated, optional)"

Write-Host ""
Write-Host "Clearing Telegram command menus..." -ForegroundColor Cyan
Delete-CommandsForScope -Token $token -Scope @{ type = "default" } -Label "default"
Delete-CommandsForScope -Token $token -Scope @{ type = "all_private_chats" } -Label "all_private_chats"
Delete-CommandsForScope -Token $token -Scope @{ type = "all_group_chats" } -Label "all_group_chats"
Delete-CommandsForScope -Token $token -Scope @{ type = "all_chat_administrators" } -Label "all_chat_administrators"

if (-not [string]::IsNullOrWhiteSpace($adminIdsRaw)) {
  foreach ($id in $adminIdsRaw.Split(",")) {
    $chatIdToClear = $id.Trim()
    if ($chatIdToClear) {
      Delete-CommandsForScope -Token $token -Scope @{ type = "chat"; chat_id = $chatIdToClear } -Label "chat:$chatIdToClear"
    }
  }
}

Write-Host ""
Write-Host "Setting clean command menu..." -ForegroundColor Cyan
$setResp = Invoke-TelegramApi -Token $token -Method "setMyCommands" -Body @{
  commands = @(
    @{ command = "start"; description = "打开使用教程" },
    @{ command = "language"; description = "切换中文或英文模式" },
    @{ command = "admin"; description = "打开管理员菜单" },
    @{ command = "apply"; description = "申请白名单权限" },
    @{ command = "whoami"; description = "查看我的Chat ID和权限" },
    @{ command = "status"; description = "查看机器人状态" },
    @{ command = "cacheclear"; description = "管理员清除查询缓存" }
  )
}
Write-Host "setMyCommands ok: $($setResp.ok)"

Write-Host ""
Write-Host "Uploading current secrets to Cloudflare..." -ForegroundColor Cyan
$token | npx wrangler secret put TELEGRAM_BOT_TOKEN
$webhookSecret | npx wrangler secret put WEBHOOK_SECRET
if (-not [string]::IsNullOrWhiteSpace($chatId)) {
  $chatId | npx wrangler secret put TELEGRAM_CHAT_ID
}

Write-Host ""
Write-Host "Deploying Worker..." -ForegroundColor Cyan
npx wrangler deploy

Write-Host ""
Write-Host "Resetting webhook..." -ForegroundColor Cyan
$deleteWebhook = Invoke-TelegramApi -Token $token -Method "deleteWebhook" -Body @{ drop_pending_updates = $true }
$setWebhook = Invoke-TelegramApi -Token $token -Method "setWebhook" -Body @{
  url = "$WorkerUrl/telegram/$webhookSecret"
  allowed_updates = @("message", "edited_message", "callback_query")
  drop_pending_updates = $true
}
Write-Host "deleteWebhook ok: $($deleteWebhook.ok)"
Write-Host "setWebhook ok:    $($setWebhook.ok)"
Write-Host "Webhook has been set successfully. Secret is hidden for safety."

$clearKv = Read-Host "Clear KV firmware monitor baseline keys? Type YES to clear"
if ($clearKv -eq "YES") {
  Write-Host "Clearing KV keys with prefix firmware:last: ..." -ForegroundColor Cyan
  $json = npx wrangler kv key list --binding FIRMWARE_KV --remote --prefix "firmware:last:"
  $keys = @()
  if (-not [string]::IsNullOrWhiteSpace($json)) {
    $keys = ($json | ConvertFrom-Json)
  }
  foreach ($item in $keys) {
    npx wrangler kv key delete $item.name --binding FIRMWARE_KV --remote
  }
  Write-Host "KV keys cleared: $($keys.Count)"
}

Write-Host ""
Write-Host "Cleanup complete." -ForegroundColor Green
Write-Host "Worker URL: $WorkerUrl"
Write-Host "Clean command menu: /start /language /admin /apply /whoami /status /cacheclear"
Write-Host ""
Write-Host "Test in Telegram:"
Write-Host "/start"
Write-Host "9380"
Write-Host "938B EUX"
Write-Host ""
Write-Host "Manual monitor check:"
Write-Host "Open /check/{WEBHOOK_SECRET}. Secret is hidden for safety."
Write-Host ""
Read-Host "Press Enter to close"
