# E59 thread watcher (ASCII ONLY) - revised 2026-09-24 (captain: continuous sampling + monotonic counter + sampler overhead)
# Per-sample line: ts / type=threads / pid / overheadMs (sampler own cost) / cpuMs{total,user,priv} (MONOTONIC) / handles / threads[]
param([int]$Target, [string]$Out, [int]$EveryMs = 250)
$ErrorActionPreference = "SilentlyContinue"
$i = 0
while ($true) {
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $p = Get-Process -Id $Target -ErrorAction SilentlyContinue
  if (-not $p) { break }
  $ts = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $cpu = 0.0; $cu = 0.0; $cp = 0.0; $h = 0
  if ($p.TotalProcessorTime) { $cpu = [math]::Round($p.TotalProcessorTime.TotalMilliseconds, 3) }
  if ($p.UserProcessorTime) { $cu = [math]::Round($p.UserProcessorTime.TotalMilliseconds, 3) }
  if ($p.PrivilegedProcessorTime) { $cp = [math]::Round($p.PrivilegedProcessorTime.TotalMilliseconds, 3) }
  if ($p.HandleCount) { $h = [int]$p.HandleCount }
  $g = $p.Threads | Group-Object ThreadState, WaitReason | Sort-Object Count -Descending | Select-Object -First 10
  $items = @()
  foreach ($x in $g) {
    $n = $x.Name -replace "\\", "/" -replace '"', ""
    $items += ('{"count":' + $x.Count + ',"name":"' + $n + '"}')
  }
  $cpuJson = ('"cpuMs":{"total":' + $cpu + ',"user":' + $cu + ',"priv":' + $cp + '}')
  $ovh = [math]::Round($sw.Elapsed.TotalMilliseconds, 3)
  $line = ('{"ts":' + $ts + ',"type":"threads","pid":' + $Target + ',"overheadMs":' + $ovh + ',' + $cpuJson + ',"handles":' + $h + ',"threads":[' + ($items -join ",") + ']}')
  Add-Content -Path $Out -Value $line -Encoding UTF8
  $i++
  if (($i % 8) -eq 0) {
    $m = Get-CimInstance Win32_PerfFormattedData_PerfOS_Memory
    $pg = Get-CimInstance Win32_PerfFormattedData_PerfOS_PagingFile
    $mx = ($pg | Measure-Object PercentUsage -Maximum).Maximum
    $pi = [double]("0" + $m.PagesInputPersec)
    $pr = [double]("0" + $m.PageReadsPersec)
    $pu = [double]("0" + $mx)
    $pl = ('{"ts":' + $ts + ',"type":"perf","pagesInputPerSec":' + $pi + ',"pageReadsPerSec":' + $pr + ',"pagingFilePercentUsage":' + $pu + '}')
    Add-Content -Path $Out -Value $pl -Encoding UTF8
  }
  Start-Sleep -Milliseconds $EveryMs
}
