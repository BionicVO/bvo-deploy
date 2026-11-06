param([ValidateSet('candidate','control','memory','backend')][string]$Config = 'candidate')
$ErrorActionPreference = 'Stop'
$fileName = if ($Config -eq 'backend') { 'backend-spike.js' } else { 'frontend-spike.js' }
$script = Get-Content -Raw (Join-Path $PSScriptRoot $fileName)
$command = "cat > /tmp/bvo-capacity.js <<'BVO_TEST'`n" + $script + "`nBVO_TEST`nk6 run -e CONFIG=$Config --quiet /tmp/bvo-capacity.js"
$build = @{
    steps = @(@{ name='grafana/k6@sha256:b24f418fc99a26dd57904c952c03bfaf79462be18508acc45aafa07ff68e7df2'; entrypoint='sh'; args=@('-c', $command) })
    options = @{ machineType='E2_HIGHCPU_8'; logging='CLOUD_LOGGING_ONLY' }
    timeout = '600s'
    tags = @('bvo-capacity-test', $Config)
}
$file = Join-Path ([System.IO.Path]::GetTempPath()) ("bvo-capacity-"+[guid]::NewGuid()+".json")
try {
    $build | ConvertTo-Json -Depth 8 | Set-Content -Encoding utf8 $file
    gcloud.cmd builds submit --no-source --config=$file --region=us-central1 --project=glass-marker-487618-i6 --async --format="value(id)"
    if ($LASTEXITCODE -ne 0) { throw 'Cloud Build submission failed' }
} finally { Remove-Item -LiteralPath $file }
